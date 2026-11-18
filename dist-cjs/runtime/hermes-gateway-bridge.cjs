const { normalizeAgentAppearance } = require("../domain/agent-appearance.cjs");

const { randomUUID } = require("node:crypto");
const { LINK_MAX_LINE_BYTES } = require("./hermes-control-link.cjs");

const { METHOD_NOT_FOUND_CODE } = require("../gateway/backend-contract.cjs");
const { managementRequest, validManagementRequest, managementResult } = require("./hermes-management.cjs");
const { withStarterCards } = require("./hermes-starter-kinds.cjs");
const { createHermesInputPredictionTranslators } = require("./hermes-input-prediction-bridge.cjs");
const { discardLinkSpillFile, writeLinkSpillFile } = require("./link-attachment-spill.cjs");
const { buildAgentRequestParams } = require("../gateway/gateway-bridge.cjs");
const { createStarMapForgetError, createStarMapUnsupportedError, isStarMapMethodNotFound, normalizeStarMapGraph, parseStarMapForgetParams } = require("../domain/star-map.cjs");
const { DEFAULT_HERMES_NAMESPACE, deriveHermesPublicKey, isAdoptableHermesSessionKey, isForeignHermesSessionKey, isHermesSessionKey, mintedHermesSessionKey, parseHermesPublicKey } = require("./hermes-session-keys.cjs");
const { normalizeHermesActivityToolPayload } = require("./hermes-activity-tool-shim.cjs");
const { LINK_PROGRAM_CARD_ICON_LLM_COMPLETE_METHOD } = require("../tools/program-card-icon-model.cjs");
const { LINK_PROGRAM_CARD_MCP_ALLOW_METHOD, LINK_PROGRAM_CARD_MCP_CALL_METHOD, LINK_PROGRAM_CARD_MCP_LIST_METHOD } = require("./program-card-mcp-hosts.cjs");

const LINK_DB_METHODS = Object.freeze({
  sessionsList: "db.sessions.list",
  sessionsSearch: "db.sessions.search",
  resolveKey: "db.sessions.resolveKey",
  setTitle: "db.sessions.setTitle",
  setRead: "db.sessions.setRead",
  setHidden: "db.sessions.setHidden",
  deleteSession: "db.sessions.delete",
  chatHistory: "db.chat.history",
  describeSession: "db.sessions.describe",
  compactionInfo: "db.sessions.compactionInfo",

  chatWatermark: "db.chat.watermark",
});

const HERMES_FEATURE_TOKEN_SESSION_READ_STATE = "session_read_state";

function normalizeHermesFeatureTokenSet(raw     ) {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const tokens = new Set();
  for (const entry of source) {
    if (typeof entry !== "string") continue;
    const token = entry.trim().toLowerCase();
    if (token) tokens.add(token);
  }
  return tokens;
}

const LINK_DB_READ_TIMEOUT_MS = 30_000;

const DB_READ_TIMEOUT = Object.freeze({ timeoutMs: LINK_DB_READ_TIMEOUT_MS });

const LINK_ADOPT_TIMEOUT_MS = 20_000;
const ADOPT_TIMEOUT_MS = Object.freeze({ timeoutMs: LINK_ADOPT_TIMEOUT_MS });

const LINK_AGENTS_ROUTE_TIMEOUT_MS = 8_000;
const AGENTS_ROUTE_TIMEOUT = Object.freeze({ timeoutMs: LINK_AGENTS_ROUTE_TIMEOUT_MS });
const AGENT_ROUTE_REASONS = new Set(["named", "router", "fallback", "single"]);

const LINK_AGENT_DESCRIBE_TIMEOUT_MS = 60_000;
const AGENT_DESCRIBE_TIMEOUT = Object.freeze({ timeoutMs: LINK_AGENT_DESCRIBE_TIMEOUT_MS });
const AGENT_DESCRIPTION_SET_MAX_CHARS = 280;

const AGENT_DESCRIBE_MAX_PROFILES = 4;

const LINK_BACKEND_EVENT_METHOD = "backend.event";

const LINK_DISPATCH_METHOD = "dispatch.send";

const LINK_GW_METHODS = Object.freeze({
  hermesManagement: "gw.hermes.management",
  modelsList: "gw.models.list",
  modelsConfigured: "gw.models.configured",
  usageStatus: "gw.usage.status",
  authStatus: "gw.auth.status",
  agentIdentity: "gw.agent.identity",
  profilesList: "gw.profiles.list",
  profilesCreate: "gw.profiles.create",
  profilesEmojiSet: "gw.profiles.emoji.set",

  agentsRoute: "gw.agents.route",

  profilesDescriptionSet: "gw.profiles.description.set",
  profilesDescriptionAuto: "gw.profiles.description.auto",
  profilesSettingsGet: "gw.profiles.settings.get",
  profilesSettingsSet: "gw.profiles.settings.set",
  profilesSoul: "gw.profiles.soul",
  skillsStatus: "gw.skills.status",
  commandsList: "gw.commands.list",

  starMapGraph: "gw.starmap.graph",

  starMapForget: "gw.starmap.forget",
});

const LINK_FOREIGN_METHODS = Object.freeze({
  copy: "foreign.sessions.copy",

  adopt: "foreign.sessions.adopt",

  driver: "foreign.sessions.driver",
});

const LINK_APPROVAL_RESOLVE_METHOD = "approval.resolve";

const LINK_APPROVAL_LLM_COMPLETE_METHOD = "approval.llm.complete";
const APPROVAL_LLM_LINK_TIMEOUT_MS = 7500;

const LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD = "program_card.review.llm.complete";

const PROGRAM_CARD_REVIEW_LLM_MAX_MS = 300_000;
const PROGRAM_CARD_REVIEW_LLM_LINK_GRACE_MS = 2000;

const LINK_PROGRAM_CARD_FRAME_LLM_COMPLETE_METHOD = "program_card.frame.llm.complete";
const PROGRAM_CARD_FRAME_LLM_MAX_MS = 420_000;
const PROGRAM_CARD_FRAME_LLM_REASONING = Object.freeze(["minimal", "low", "medium", "high"]);

function cardReviewUsage(raw     ) {
  if (!raw || typeof raw !== "object") return null;
  const usage      = {};
  for (const key of ["inputTokens", "outputTokens", "costUsd"]) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) usage[key] = value;
  }
  return "inputTokens" in usage || "outputTokens" in usage ? usage : null;
}

const PROGRAM_CARD_MCP_LIST_LINK_TIMEOUT_MS = 10_000;
const PROGRAM_CARD_MCP_CALL_MAX_MS = 30_000;
const PROGRAM_CARD_MCP_CALL_LINK_GRACE_MS = 2000;
const PROGRAM_CARD_MCP_ALLOW_LINK_TIMEOUT_MS = 10_000;

const LINK_APPROVAL_EXPLAIN_SETTING_METHOD = "approval.explain.setting";
const APPROVAL_EXPLAIN_SETTING_LINK_TIMEOUT_MS = 5000;

const LINK_WAITING_SETTINGS_METHOD = "waiting.settings";
const WAITING_SETTINGS_LINK_TIMEOUT_MS = 5000;
const WAITING_SETTINGS_SURFACE_RE = /^[a-z0-9_-]{1,32}$/;
const WAITING_SETTINGS_SURFACES_MAX = 32;

const LINK_WAITING_ANSWER_METHOD = "waiting.answer";
const WAITING_ANSWER_LINK_TIMEOUT_MS = 10000;
const WAITING_ANSWER_REASON_MAX_CHARS = 500;
const LINK_CLARIFY_RESOLVE_METHOD = "clarify.resolve";
const LINK_CLARIFY_AWAIT_TEXT_METHOD = "clarify.await_text";
const LINK_SESSION_METHODS = Object.freeze({
  abort: "sessions.abort",
  steer: "sessions.steer",
  optionsApply: "sessions.options.apply",
});

const LINK_PROFILE_METHODS = Object.freeze({
  optionsGet: "profile.options.get",
  optionsApply: "profile.options.apply",
});

const LINK_ATTACHMENT_INLINE_MAX_CHARS = 262144;

const DENIED_SESSION_SOURCES = Object.freeze(["tool", "cron", "subagent"]);

const SESSIONS_GONE_EVENT = "sessionsGone";
const NATIVE_ID_INDEX_MAX = 4096;

function methodNotFoundError(method) {
  const err = new Error(`method not found: ${method || "<missing>"}`);
  err.code = METHOD_NOT_FOUND_CODE;
  return err;
}

function normalizeBackendEventPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const identity = payload.sessionIdentity;
  if (
    typeof payload.sessionKey === "string" &&
    payload.sessionKey
  ) {
    if (identity === undefined) return normalizeHermesActivityToolPayload(payload);
    const { sessionIdentity, ...rest } = payload;
    return normalizeHermesActivityToolPayload(rest);
  }
  if (!identity || typeof identity !== "object") {
    return normalizeHermesActivityToolPayload(payload);
  }
  const { sessionIdentity, ...rest } = payload;
  try {
    rest.sessionKey = mintedHermesSessionKey(identity.chatId, identity.ns);
  } catch {
    return normalizeHermesActivityToolPayload(payload);
  }
  return normalizeHermesActivityToolPayload(rest);
}

function collapseHermesCommandConfirmationContent(content) {
  if (typeof content === "string") {
    return collapseHermesCommandConfirmation(content);
  }
  if (!Array.isArray(content)) return content;
  let changed = false;
  const mapped = content.map((block) => {
    if (
      !block ||
      typeof block !== "object" ||
      block.type !== "text" ||
      typeof block.text !== "string"
    ) {
      return block;
    }
    const collapsed = collapseHermesCommandConfirmation(block.text);
    if (collapsed === block.text) return block;
    changed = true;
    return { ...block, text: collapsed };
  });
  return changed ? mapped : content;
}

function normalizeHermesDisplayEventPayload(name, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  if (name === "message" && payload.role === "assistant" && hasOwn(payload, "content")) {
    const content = collapseHermesCommandConfirmationContent(payload.content);
    return content === payload.content ? payload : { ...payload, content };
  }
  if (name === "streaming" && typeof payload.text === "string") {
    const text = collapseHermesCommandConfirmation(payload.text);
    return text === payload.text ? payload : { ...payload, text };
  }
  return payload;
}

function keyToIdentity(key) {
  const parsed = parseHermesPublicKey(typeof key === "string" ? key.trim() : "");
  if (!parsed) {
    throw new Error(`not a hermes session key: ${JSON.stringify(key)}`);
  }
  if (parsed.kind === "minted") {
    return { ns: parsed.namespace, chatId: parsed.chatId };
  }
  return { ns: parsed.namespace, remainder: parsed.remainder };
}

function keyToMintedTarget(key, fieldName, nonMintedMessage = "") {
  const parsed = parseHermesPublicKey(typeof key === "string" ? key.trim() : "");
  if (!parsed) {
    throw new Error(`${fieldName} must be a hermes minted session key`);
  }
  if (parsed.kind !== "minted") {
    throw new Error(
      nonMintedMessage || `${fieldName} must target an OcuClaw-minted session`,
    );
  }
  return {
    publicKey: key.trim(),
    target: { ns: parsed.namespace, chatId: parsed.chatId },
  };
}

function normalizeDeliverReply(value, fallback = null) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return fallback;
  if (raw !== "local" && raw !== "origin") {
    throw new Error("deliverReply must be 'local' or 'origin'");
  }
  return raw;
}

function defaultCopyTargetKey() {
  return mintedHermesSessionKey(
    `copy-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

function copiedSessionPublicKey(session, fallbackKey) {
  if (!session || typeof session !== "object") return fallbackKey;
  const rowKey = cleanNonEmptyString(session.key);
  if (rowKey && isHermesSessionKey(rowKey)) return rowKey;
  const publicKey = cleanNonEmptyString(session.publicKey);
  if (publicKey && isHermesSessionKey(publicKey)) return publicKey;
  if (cleanNonEmptyString(session.sessionKey)) {
    const derived = deriveHermesPublicKey(session);
    if (derived && cleanNonEmptyString(derived.key)) return derived.key;
  }
  return fallbackKey;
}

const THINKING_TO_HERMES_LEVEL = Object.freeze({
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
});

const HERMES_COMMAND_CATEGORY = Object.freeze({
  Session: "session",
  Configuration: "options",
  Info: "status",
  "Tools & Skills": "tools",
});

function sessionOptionsFallbackCommands(options     ) {
  const commands = [];
  if (hasOwn(options, "model")) {
    const model = String(options.model || "").trim();
    if (!model) {
      throw new Error(
        "clearing the session model needs a Hermes with structured session options (upstream PR #92187); pick a model instead",
      );
    }
    const provider = String(options.provider || "").trim();
    commands.push(`/model ${model}${provider ? ` --provider ${provider}` : ""}`);
  }
  if (hasOwn(options, "reasoning_effort")) {
    const effort = String(options.reasoning_effort || "").trim();
    commands.push(effort ? `/reasoning ${effort}` : "/reasoning reset");
  }
  if (hasOwn(options, "fast")) {
    commands.push(options.fast ? "/fast on" : "/fast off");
  }
  return commands;
}

function isQuietSettingsCommand(command        ) {
  return /^\/fast (on|off)$/.test(command);
}

const QUIET_RUN_TTL_MS = 60_000;
const QUIET_RUN_MAX = 64;

const REASONING_DISPLAY_TO_SHOW_REASONING = Object.freeze({
  off: false,
  on: true,
});

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function cleanNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const PROFILE_CREATE_ERROR_CODES = new Set([
  "agent_already_exists",
  "invalid_name",
  "reserved_agent_id",
]);

function profileCreateError(error     , name        ) {
  const message = typeof error?.message === "string" ? error.message : "";
  const tagged = cleanNonEmptyString(error?.errorCode);
  let code = tagged && PROFILE_CREATE_ERROR_CODES.has(tagged) ? tagged : null;
  if (!code) {
    if (/^A profile named .+ already exists\.$|^Profile already exists\b/.test(message)) {
      code = "agent_already_exists";
    } else if (/name is reserved|choose a name other than default/i.test(message)) {
      code = "reserved_agent_id";
    } else if (/^That name can't be used for an agent\b|^Enter a name for the agent\b/.test(message)) {
      code = "invalid_name";
    } else if (
      error?.code === "link_request_timeout" ||
      error?.delivery === "not_sent" ||
      error?.delivery === "uncertain"
    ) {
      code = "backend_unavailable";
    }
  }
  if (!code) return error;
  const text =
    code === "agent_already_exists" && !/^A profile named /.test(message)
      ? `A profile named ${name} already exists.`
      : code === "reserved_agent_id" && !/name is reserved/i.test(message)
        ? "This profile name is reserved. Choose another name."
        : code === "backend_unavailable"
          ? "Hermes is not reachable right now. Try again in a moment."
          : message;
  return Object.assign(new Error(text), { code });
}

function profileReadParams(params) {
  const parsed = parseHermesPublicKey(
    params && typeof params.sessionKey === "string" ? params.sessionKey : "",
  );
  return parsed && parsed.namespace ? { ns: parsed.namespace } : {};
}

function hasOwn(object, field) {
  return Object.prototype.hasOwnProperty.call(object || {}, field);
}

function alignUsageWindowLabel(label) {
  const trimmed = typeof label === "string" ? label.trim() : "";
  const normalized = trimmed.toLowerCase();
  if (/^(current\s+)?session$/.test(normalized)) return "5h";
  if (/^(current\s+)?week(ly)?$/.test(normalized)) return "week";
  return trimmed;
}

function buildModelRef(row) {
  if (!row || typeof row !== "object") return null;
  const id = cleanNonEmptyString(row.id);
  if (!id) return null;
  const provider = cleanNonEmptyString(row.provider);
  return provider ? `${provider}/${id}` : id;
}

function defaultRunId() {
  const globalCrypto = globalThis && globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return `hermes-run-${globalCrypto.randomUUID()}`;
  }
  return `hermes-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultIdempotencyKey() {
  const globalCrypto = globalThis && globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  return `ocuclaw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const RESERVED_SESSION_CONTROL_SLUGS = new Set(["new", "reset", "stop"]);
const MODEL_SWITCHED_PREFIX = "Model switched to ";
const MODEL_RESET_PREFIX = "Model reset";

function firstNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function collapseHermesCommandConfirmation(text) {
  if (typeof text !== "string") return text;
  const firstLine = firstNonEmptyLine(text);
  if (
    !firstLine.startsWith(MODEL_SWITCHED_PREFIX) &&
    !firstLine.startsWith(MODEL_RESET_PREFIX)
  ) {
    return text;
  }
  if (!text.includes("\nProvider: ") && !text.includes("\n(session only")) {
    return text;
  }
  return firstLine;
}

function translateHermesSkillSlash(message) {
  if (typeof message !== "string") return "";
  const match = /^\/skill(?:\s+(.+))?$/i.exec(message.trim());
  if (!match) return message;
  const name = String(match[1] || "").trim();
  if (!name) return "/skill";
  const slug = name
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (RESERVED_SESSION_CONTROL_SLUGS.has(slug)) return message.trim();
  return slug ? `/${slug}` : "/skill";
}

function routeDispatchSessionKey(rawKey) {
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key || key === "main") {
    return {
      publicKey: mintedHermesSessionKey("main"),
      target: { ns: DEFAULT_HERMES_NAMESPACE, chatId: "main" },
    };
  }
  const parsed = parseHermesPublicKey(key);
  if (parsed) {
    if (parsed.kind === "minted") {
      return {
        publicKey: key,
        target: { ns: parsed.namespace, chatId: parsed.chatId },
      };
    }
    throw new Error(
      `foreign hermes session keys cannot be dispatched directly ` +
        `(copy the session to glasses first): ${key}`,
    );
  }
  if (key.indexOf(":") === -1) {
    return {
      publicKey: mintedHermesSessionKey(key),
      target: { ns: DEFAULT_HERMES_NAMESPACE, chatId: key },
    };
  }
  throw new Error(`not a hermes session key: ${JSON.stringify(key)}`);
}

function createDefaultAttachmentTransport() {
  return {

    async prepare(attachments) {
      const descriptors = [];
      const spilled = [];
      try {
        for (const attachment of attachments) {
          if (!attachment || typeof attachment !== "object") continue;
          const descriptor = {};
          for (const field of [
            "type",
            "mimeType",
            "fileName",
            "source",
            "sizeBytes",
            "widthPx",
            "heightPx",
          ]) {
            if (attachment[field] !== undefined) descriptor[field] = attachment[field];
          }
          const content =
            typeof attachment.content === "string" ? attachment.content : "";
          if (content.length > LINK_ATTACHMENT_INLINE_MAX_CHARS) {

            const spillPath = await writeLinkSpillFile(content);
            descriptor.path = spillPath;
            spilled.push(spillPath);
          } else {
            descriptor.content = content;
          }
          descriptors.push(descriptor);
        }
      } catch (err) {

        for (const spillPath of spilled) discardLinkSpillFile(spillPath);
        throw err;
      }
      return {
        descriptors,
        cleanup() {

          for (const spillPath of spilled) discardLinkSpillFile(spillPath);
        },
      };
    },
  };
}

function mapListRow(row) {
  if (!row || typeof row !== "object") return null;
  if (DENIED_SESSION_SOURCES.indexOf(row.source) !== -1) return null;
  const derived = deriveHermesPublicKey(row);
  if (!derived) return null;
  const lastActiveSeconds = toFiniteNumber(row.lastActive);

  const activityDescription = cleanNonEmptyString(row.lastActivityDescription);

  const unread = typeof row.unread === "boolean" ? row.unread : null;
  const hidden = typeof row.hidden === "boolean" ? row.hidden : null;
  const mapped = {
    key: derived.key,
    ...(row.agentStatus && typeof row.agentStatus === "object"
      ? { agentStatus: row.agentStatus }
      : {}),

    updatedAt:
      lastActiveSeconds === null ? 0 : Math.floor(lastActiveSeconds * 1000),
    ...(activityDescription
      ? { lastActivityDescription: activityDescription }
      : {}),
    ...(unread === null ? {} : { unread }),
    ...(hidden === null ? {} : { hidden }),
  };

  const source = derived.kind === "foreign"
    ? cleanNonEmptyString(row.createdSource) ?? cleanNonEmptyString(row.source)
    : null;
  if (source) Reflect.set(mapped, "source", source);
  if (typeof row.preview === "string" && row.preview) {
    mapped.preview = row.preview;
  }
  if (typeof row.title === "string" && row.title) {
    mapped.title = row.title;
  }
  for (const field of ["model", "modelProvider", "thinkingLevel", "reasoningLevel"]) {
    if (typeof row[field] === "string" && row[field].trim()) {
      mapped[field] = row[field];
    }
  }

  if (typeof row.fastMode === "boolean") Reflect.set(mapped, "fastMode", row.fastMode);

  if (typeof row.fastModeSupported === "boolean") {
    Reflect.set(mapped, "fastModeSupported", row.fastModeSupported);
  }

  return mapped;
}

const COMPACTION_SUMMARY_OPENERS = Object.freeze([

  "[CONTEXT COMPACTION — REFERENCE ONLY]",

  "[CONTEXT SUMMARY]:",
]);

const MERGED_SUMMARY_DELIMITER =
  "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]";

function contentTextForSummaryClassification(content         ) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function startsWithSummaryOpener(text     ) {
  for (const opener of COMPACTION_SUMMARY_OPENERS) {
    if (text.startsWith(opener)) return true;
  }
  return false;
}

function classifyCompactionSummary(content         ) {
  const text = contentTextForSummaryClassification(content).replace(/^\s+/, "");
  if (!text) return null;

  const at = text.indexOf(MERGED_SUMMARY_DELIMITER);
  if (at >= 0) {
    const after = text
      .slice(at + MERGED_SUMMARY_DELIMITER.length)
      .replace(/^\s+/, "");
    return startsWithSummaryOpener(after) ? "merged" : null;
  }
  return startsWithSummaryOpener(text) ? "standalone" : null;
}

function shapeConversationMessages(rawMessages, limit) {
  const messages = [];
  const source = Array.isArray(rawMessages) ? rawMessages : [];
  for (const msg of source) {
    if (!msg || typeof msg !== "object") continue;
    const role = typeof msg.role === "string" ? msg.role : "";
    if (role !== "user" && role !== "assistant") continue;
    const content = msg.content;
    const summaryKind = classifyCompactionSummary(content);
    const summaryAnnotation = summaryKind
      ? { compactionSummary: summaryKind }
      : {};
    if (typeof content === "string") {
      if (!content) continue;
      messages.push({
        ...shapeConversationEntry(msg, role, content),
        ...summaryAnnotation,
      });
    } else if (Array.isArray(content)) {
      const blocks = content.filter(
        (block) => block && typeof block === "object",
      );
      if (blocks.length === 0) continue;
      messages.push({
        ...shapeConversationEntry(msg, role, blocks),
        ...summaryAnnotation,
      });
    }

  }
  const max =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
  return max !== null && messages.length > max ? messages.slice(-max) : messages;
}

function shapeConversationEntry(
  msg     ,
  role     ,
  content     ,
) {
  const shaped = { role, content };
  if (typeof msg.id === "string" || typeof msg.id === "number") {
    Object.assign(shaped, { id: msg.id });
  }
  if (typeof msg.timestamp === "string" || typeof msg.timestamp === "number") {
    const timestampSeconds = Number(msg.timestamp);
    if (Number.isFinite(timestampSeconds)) {
      Object.assign(shaped, { timestamp: Math.floor(timestampSeconds * 1000) });
    }
  }
  if (
    typeof msg.platform_message_id === "string" ||
    typeof msg.platform_message_id === "number"
  ) {
    Object.assign(shaped, { platform_message_id: msg.platform_message_id });
  }
  return shaped;
}

function splitSearchSnippet(rawSnippet         , query         ) {
  const snippet = typeof rawSnippet === "string" ? rawSnippet : "";
  const open = snippet.indexOf(">>>");
  const close = open >= 0 ? snippet.indexOf("<<<", open + 3) : -1;
  if (open >= 0 && close >= open + 3) {
    return {
      before: snippet.slice(0, open).replaceAll(">>>", "").replaceAll("<<<", ""),
      match: snippet.slice(open + 3, close),
      after: snippet.slice(close + 3).replaceAll(">>>", "").replaceAll("<<<", ""),
    };
  }
  const needle = typeof query === "string" ? query.trim() : "";
  const index = needle ? snippet.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (index >= 0) {
    return {
      before: snippet.slice(0, index),
      match: snippet.slice(index, index + needle.length),
      after: snippet.slice(index + needle.length),
    };
  }
  return { before: "", match: snippet, after: "" };
}

function createHermesGatewayBridge(opts) {
  const link = opts && opts.link;
  if (!link || typeof link.request !== "function") {
    throw new Error("hermes gateway bridge requires a control link with request()");
  }
  const logger = (opts && opts.logger) || console;
  const runIdFactory =
    opts && typeof opts.runIdFactory === "function"
      ? opts.runIdFactory
      : defaultRunId;
  const idempotencyKeyFactory =
    opts && typeof opts.idempotencyKeyFactory === "function"
      ? opts.idempotencyKeyFactory
      : defaultIdempotencyKey;
  const attachmentTransport =
    opts && opts.attachmentTransport && typeof opts.attachmentTransport.prepare === "function"
      ? opts.attachmentTransport
      : createDefaultAttachmentTransport();

  const hermesFeatureTokens = normalizeHermesFeatureTokenSet(
    opts && opts.featureTokens !== undefined
      ? opts.featureTokens

      : process.env.OCUCLAW_HERMES_FEATURES,
  );
  const sessionReadStateSupported = () =>
    hermesFeatureTokens.has(HERMES_FEATURE_TOKEN_SESSION_READ_STATE);

  const quietRuns = new Map                ();
  function markQuietRun(runId        ) {
    const now = Date.now();
    for (const [id, at] of quietRuns) {
      if (now - at <= QUIET_RUN_TTL_MS && quietRuns.size < QUIET_RUN_MAX) break;
      quietRuns.delete(id);
    }
    quietRuns.set(runId, now);
  }

  function isQuietRunEvent(name        , payload     ) {
    if (name !== "message" && name !== "streaming" && name !== "activity") return false;
    const runId = payload && typeof payload === "object" ? payload.runId : null;
    if (typeof runId !== "string" || !quietRuns.has(runId)) return false;
    if (name === "activity" && payload.origin === "lifecycle" &&
      (payload.phase === "end" || payload.phase === "error")) {
      quietRuns.delete(runId);
    }
    return true;
  }

  const publicKeyByNativeId = new Map();
  function rememberNativeIds(row     , publicKey        ) {
    for (const value of [row.id, row.lineageRootId]) {
      const id = cleanNonEmptyString(value);
      if (!id) continue;
      publicKeyByNativeId.delete(id);
      publicKeyByNativeId.set(id, publicKey);
    }
    while (publicKeyByNativeId.size > NATIVE_ID_INDEX_MAX) {
      publicKeyByNativeId.delete(publicKeyByNativeId.keys().next().value);
    }
  }
  function withGoneSessionKeys(payload     ) {
    if (!payload || typeof payload !== "object") return payload;
    const ids = Array.isArray(payload.ids)
      ? payload.ids.filter((id     ) => typeof id === "string" && id)
      : [];
    const sessionKeys           = [];
    let unmappedIds = 0;
    for (const id of ids) {
      const key = publicKeyByNativeId.get(id);
      if (!key) {
        unmappedIds += 1;
        continue;
      }
      if (!sessionKeys.includes(key)) sessionKeys.push(key);

      if (payload.reason !== "archive") publicKeyByNativeId.delete(id);
    }
    return { ...payload, ids, sessionKeys, unmappedIds };
  }

  async function prepareAttachments(params, linkParams) {
    if (params && Array.isArray(params.attachments) && params.attachments.length > 0) {
      const prepared = await attachmentTransport.prepare(params.attachments);
      if (prepared.descriptors.length > 0) {
        linkParams.attachments = prepared.descriptors;
      }
      return prepared;
    }
    return null;
  }

  const sendChains = new Map();

  function serializeSend(sessionKey     , issue     ) {
    const key = typeof sessionKey === "string" && sessionKey ? sessionKey : "";
    const previous = sendChains.get(key) || Promise.resolve();
    const run = previous.then(issue);

    const tail = run.then(
      () => {},
      () => {},
    );
    sendChains.set(key, tail);
    tail.then(() => {

      if (sendChains.get(key) === tail) sendChains.delete(key);
    });
    return run;
  }

  function issueRequest(method     , linkParams     ) {
    let pending;
    try {
      pending = Promise.resolve(link.request(method, linkParams));
    } catch (err) {

      pending = Promise.reject(err);
    }

    pending.catch(() => {});
    return pending;
  }

  async function stageAndIssue(params     , method     , linkParams     ) {
    const prepared = await prepareAttachments(params, linkParams);
    return { prepared, pending: issueRequest(method, linkParams) };
  }

  async function dispatchTurn(params) {
    const runId = runIdFactory();
    if (params && params.quiet === true) markQuietRun(runId);
    const route = routeDispatchSessionKey(params && params.sessionKey);
    const dispatchParams = {
      runId,
      sessionKey: route.publicKey,
      target: route.target,
      message:
        params && typeof params.message === "string"
          ? translateHermesSkillSlash(params.message)
          : "",
    };

    if (params && typeof params.idempotencyKey === "string" && params.idempotencyKey) {
      dispatchParams.idempotencyKey = params.idempotencyKey;
    }
    if (
      params &&
      typeof params.extraSystemPrompt === "string" &&
      params.extraSystemPrompt
    ) {
      dispatchParams.channelPrompt = params.extraSystemPrompt;
    }
    if (params && typeof params.promptOwner === "string" && params.promptOwner) {
      Reflect.set(dispatchParams, "promptOwner", params.promptOwner);
    }
    if (params && typeof params.promptLane === "string" && params.promptLane) {
      Reflect.set(dispatchParams, "promptLane", params.promptLane);
    }

    if (params && typeof params.thinking === "string" && params.thinking) {
      dispatchParams.thinking = params.thinking;
    }
    if (params && typeof params.agentId === "string" && params.agentId) {
      dispatchParams.agentId = params.agentId;
    }
    const deliverReply = normalizeDeliverReply(params && params.deliverReply);
    if (deliverReply) {
      dispatchParams.deliverReply = deliverReply;
    }
    const { prepared, pending } = await serializeSend(route.publicKey, () =>
      stageAndIssue(params, LINK_DISPATCH_METHOD, dispatchParams),
    );
    let result;
    try {
      result = await pending;
    } catch (err) {

      if (prepared) prepared.cleanup();
      throw err;
    }
    const ack = { runId };
    if (result && typeof result === "object") {

      if (typeof result.runId === "string" && result.runId) {
        ack.runId = result.runId;
      }
      if (typeof result.status === "string" && result.status) {
        ack.status = result.status;
      }
      if (typeof result.error === "string" && result.error) {
        ack.error = result.error;
      }
      if (typeof result.sessionState === "string" && result.sessionState) {
        ack.sessionState = result.sessionState;
      }
    }
    if (prepared && ack.status && ack.status !== "accepted") {

      prepared.cleanup();
    }
    return ack;
  }

  const translators = {

    ...createHermesInputPredictionTranslators({ link }),

    async [LINK_APPROVAL_LLM_COMPLETE_METHOD](params      = {}) {
      const source = params && typeof params === "object" ? params : {};
      const linkParams      = {
        messages: Array.isArray(source.messages) ? source.messages : [],
        timeoutMs: APPROVAL_LLM_LINK_TIMEOUT_MS - 500,
      };
      if (Number.isFinite(source.maxTokens)) linkParams.maxTokens = source.maxTokens;
      if (Number.isFinite(source.temperature)) linkParams.temperature = source.temperature;
      const result      = await link.request(LINK_APPROVAL_LLM_COMPLETE_METHOD, linkParams, {
        timeoutMs: APPROVAL_LLM_LINK_TIMEOUT_MS,
        signal: source.signal,
      });
      if (result && typeof result.text === "string") return { text: result.text };
      const reason = result && typeof result.error === "string" ? result.error : "no text";
      throw new Error(`approval explain ${reason}`);
    },

    async [LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD](params      = {}, method = LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD,
      { maxMs = PROGRAM_CARD_REVIEW_LLM_MAX_MS, reasoning = false }                                          = {}) {
      const source = params && typeof params === "object" ? params : {};
      const timeoutMs = Number.isFinite(source.timeoutMs)
        ? Math.max(1000, Math.min(maxMs, source.timeoutMs))
        : PROGRAM_CARD_REVIEW_LLM_MAX_MS;
      const linkParams      = {
        callId: randomUUID(),
        messages: Array.isArray(source.messages) ? source.messages : [],
        timeoutMs,
      };
      if (reasoning && PROGRAM_CARD_FRAME_LLM_REASONING.includes(source.reasoning)) linkParams.reasoning = source.reasoning;
      if (Number.isFinite(source.maxTokens)) linkParams.maxTokens = source.maxTokens;
      if (Number.isFinite(source.temperature)) linkParams.temperature = source.temperature;
      if (source.signal?.aborted) throw Object.assign(new Error("card review cancelled"), { code: "model_cancelled" });
      if (new TextEncoder().encode(JSON.stringify(linkParams)).byteLength > LINK_MAX_LINE_BYTES - 1024) {
        throw Object.assign(new Error("card review payload exceeds the Hermes link limit"), { code: "look_payload_too_large" });
      }

      const cancel = () => {
        try {
          Promise.resolve(link.request(method.replace(/complete$/, "cancel"), { callId: linkParams.callId }, { timeoutMs: 2000 }))
            .catch(() => {});
        } catch {  }
      };
      source.signal?.addEventListener("abort", cancel, { once: true });
      let result     ;
      try {
        result = await link.request(method, linkParams, {
          timeoutMs: timeoutMs + PROGRAM_CARD_REVIEW_LLM_LINK_GRACE_MS,
          signal: source.signal,
        });
      } finally {
        source.signal?.removeEventListener("abort", cancel);
      }
      if (result && typeof result.text === "string") {
        return { text: result.text,
          ...(typeof result.model === "string" && result.model ? { model: result.model.slice(0, 160) } : {}),
          ...(typeof result.provider === "string" && result.provider ? { provider: result.provider.slice(0, 80) } : {}),
          ...(Array.isArray(result.modelInput) ? { modelInput: result.modelInput.filter((kind     ) => kind === "text" || kind === "image") } : {}),

          ...(typeof result.stopReason === "string" && /^[a-z_]{1,32}$/.test(result.stopReason) ? { stopReason: result.stopReason } : {}),
          ...(cardReviewUsage(result.usage) ? { usage: cardReviewUsage(result.usage) } : {}),
          ...(typeof result.imageModel?.provider === "string" && result.imageModel.provider.length <= 160 &&
            typeof result.imageModel?.model === "string" && result.imageModel.model.length <= 160 ? { imageModel: {
              provider: result.imageModel.provider, model: result.imageModel.model,
              input: Array.isArray(result.imageModel.input) ? result.imageModel.input.filter((kind     ) => kind === "text" || kind === "image") : [],
            } } : {}),
        };
      }
      const reason = result && typeof result.error === "string" ? result.error : "no text";
      throw Object.assign(new Error(["timeout", "TimeoutError", "APITimeoutError"].includes(reason) ? "card review timeout" : "card review failed"), {
        code: ["timeout", "TimeoutError", "APITimeoutError"].includes(reason) ? "model_timeout" : "model_error",

        failure: result?.failure,
        name: reason === "RateLimitError" ? reason : "Error",
      });
    },
    async "task.proposal.llm.complete"(params      = {}) {
      return translators[LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD](params, "task.proposal.llm.complete");
    },

    async "agent.draft.llm.complete"(params      = {}) {
      return translators[LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD](params, "agent.draft.llm.complete");
    },

    async [LINK_PROGRAM_CARD_FRAME_LLM_COMPLETE_METHOD](params      = {}) {
      return translators[LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD](params, LINK_PROGRAM_CARD_FRAME_LLM_COMPLETE_METHOD,
        { maxMs: PROGRAM_CARD_FRAME_LLM_MAX_MS, reasoning: true });
    },

    async [LINK_PROGRAM_CARD_ICON_LLM_COMPLETE_METHOD](params      = {}) {
      return translators[LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD](params, LINK_PROGRAM_CARD_ICON_LLM_COMPLETE_METHOD);
    },

    async [LINK_PROGRAM_CARD_MCP_LIST_METHOD]() {
      return link.request(LINK_PROGRAM_CARD_MCP_LIST_METHOD, {}, { timeoutMs: PROGRAM_CARD_MCP_LIST_LINK_TIMEOUT_MS });
    },
    async "program_card.model.complete"(params     ) { return link.request("program_card.model.complete", params, { timeoutMs: 62000 }); },
    async "program_card.model.cancel"(params     ) { return link.request("program_card.model.cancel", params, { timeoutMs: 2000 }); },
    async "program_card.model.models"(params     ) { return link.request("program_card.model.models", params, { timeoutMs: 10000 }); },
    async "program_card.model.allow"(params     ) { return link.request("program_card.model.allow", params, { timeoutMs: 10000 }); },

    async [LINK_PROGRAM_CARD_MCP_CALL_METHOD](params      = {}) {
      const source = params && typeof params === "object" ? params : {};
      const timeoutMs = Number.isFinite(source.timeoutMs)
        ? Math.max(1000, Math.min(PROGRAM_CARD_MCP_CALL_MAX_MS, source.timeoutMs))
        : 10_000;
      return link.request(
        LINK_PROGRAM_CARD_MCP_CALL_METHOD,
        {
          server: typeof source.server === "string" ? source.server : "",
          tool: typeof source.tool === "string" ? source.tool : "",
          args: source.args && typeof source.args === "object" && !Array.isArray(source.args) ? source.args : {},
          timeoutMs,
          ...(source.write === true ? { write: true } : {}),
          ...(source.ownerWrite === true ? { ownerWrite: true } : {}),
        },
        { timeoutMs: timeoutMs + PROGRAM_CARD_MCP_CALL_LINK_GRACE_MS },
      );
    },

    async [LINK_PROGRAM_CARD_MCP_ALLOW_METHOD](params      = {}) {
      const source = params && typeof params === "object" ? params : {};
      return link.request(
        LINK_PROGRAM_CARD_MCP_ALLOW_METHOD,
        { server: typeof source.server === "string" ? source.server : "", allow: source.allow === true },
        { timeoutMs: PROGRAM_CARD_MCP_ALLOW_LINK_TIMEOUT_MS },
      );
    },

    async [LINK_APPROVAL_EXPLAIN_SETTING_METHOD](params      = {}) {
      const enabled = !(params && params.enabled === false);
      return link.request(
        LINK_APPROVAL_EXPLAIN_SETTING_METHOD,
        { enabled },
        { timeoutMs: APPROVAL_EXPLAIN_SETTING_LINK_TIMEOUT_MS },
      );
    },

    async [LINK_WAITING_SETTINGS_METHOD](params      = {}) {
      const source = params && typeof params === "object" ? params : {};
      const rawSurfaces =
        source.surfaces && typeof source.surfaces === "object" && !Array.isArray(source.surfaces)
          ? source.surfaces
          : {};
      const surfaces      = {};
      for (const name of Object.keys(rawSurfaces).sort()) {
        if (Object.keys(surfaces).length >= WAITING_SETTINGS_SURFACES_MAX) break;
        if (!WAITING_SETTINGS_SURFACE_RE.test(name)) continue;
        if (typeof rawSurfaces[name] !== "boolean") continue;
        surfaces[name] = rawSurfaces[name];
      }
      return link.request(
        LINK_WAITING_SETTINGS_METHOD,
        { show: source.show !== false, answer: source.answer === true, surfaces },
        { timeoutMs: WAITING_SETTINGS_LINK_TIMEOUT_MS },
      );
    },

    async [LINK_WAITING_ANSWER_METHOD](params      = {}) {
      const source = params && typeof params === "object" ? params : {};
      const requestId = cleanNonEmptyString(source.requestId);
      const choice = cleanNonEmptyString(source.choice);
      const answer =
        typeof source.answer === "string" && source.answer.trim() ? source.answer : null;
      if (!requestId) throw new Error("waiting.answer requires requestId");
      if (!choice === !answer) throw new Error("waiting.answer requires exactly one of choice or answer");
      const forwarded      = { requestId };
      if (choice) {
        forwarded.choice = choice;
        const reason = cleanNonEmptyString(source.reason);
        if (reason) forwarded.reason = reason.slice(0, WAITING_ANSWER_REASON_MAX_CHARS);
      } else {
        forwarded.answer = answer;
      }
      return link.request(LINK_WAITING_ANSWER_METHOD, forwarded, {
        timeoutMs: WAITING_ANSWER_LINK_TIMEOUT_MS,
      });
    },

    async agent(params) {
      return dispatchTurn(params);
    },

    async status() {

      return { ok: true };
    },

    async "sessions.abort"(params) {
      const route = routeDispatchSessionKey(
        (params && (params.key || params.sessionKey)) || null,
      );

      const { pending } = await serializeSend(route.publicKey, () => ({
        pending: issueRequest(LINK_SESSION_METHODS.abort, {
          sessionKey: route.publicKey,
          target: route.target,
        }),
      }));
      return pending;
    },

    async "sessions.steer"(params) {
      const runId = runIdFactory();
      const route = routeDispatchSessionKey(
        (params && (params.key || params.sessionKey)) || null,
      );
      const linkParams = {
        runId,
        sessionKey: route.publicKey,
        target: route.target,
        message:
          params && typeof params.message === "string" ? params.message : "",
      };
      const idem = cleanNonEmptyString(params && params.idempotencyKey);
      if (idem) linkParams.idempotencyKey = idem;
      const { prepared, pending } = await serializeSend(route.publicKey, () =>
        stageAndIssue(params, LINK_SESSION_METHODS.steer, linkParams),
      );
      let result;
      try {
        result = await pending;
      } catch (err) {
        if (prepared) prepared.cleanup();
        throw err;
      }
      const ack = {};
      if (result && typeof result === "object") {
        if (typeof result.runId === "string" && result.runId) {
          ack.runId = result.runId;
        }
        if (typeof result.status === "string" && result.status) {
          ack.status = result.status;
        }
        if (typeof result.error === "string" && result.error) {
          ack.error = result.error;
        }
      }
      if (
        ack.status &&
        ack.status !== "accepted" &&
        ack.status !== "started"
      ) {
        if (prepared) prepared.cleanup();
        throw new Error(ack.error || `sessions.steer ${ack.status}`);
      }
      return ack;
    },

    async "clarify.resolve"(params     ) {
      const id = cleanNonEmptyString(params && params.id);
      const response = cleanNonEmptyString(params && params.response);
      if (!id) throw new Error("clarify.resolve requires id");
      if (!response) throw new Error("clarify.resolve requires response");
      const result = await link.request(LINK_CLARIFY_RESOLVE_METHOD, { id, response });
      const status = cleanNonEmptyString(result && result.status);
      if (status && status !== "accepted") {
        const reason =
          cleanNonEmptyString(result && result.reason) ||
          cleanNonEmptyString(result && result.error) ||
          status;
        throw new Error(`clarify resolve ${reason}`);
      }
      return result;
    },

    async "clarify.await_text"(params     ) {
      const id = cleanNonEmptyString(params && params.id);
      if (!id) throw new Error("clarify.await_text requires id");
      const result = await link.request(LINK_CLARIFY_AWAIT_TEXT_METHOD, { id });
      const status = cleanNonEmptyString(result && result.status);
      if (status && status !== "accepted") {
        const reason =
          cleanNonEmptyString(result && result.reason) ||
          cleanNonEmptyString(result && result.error) ||
          status;
        throw new Error(`clarify await text ${reason}`);
      }
      return result;
    },

    async "models.list"(params) {

      const result = await link.request(
        LINK_GW_METHODS.modelsList,
        profileReadParams(params),
      );
      const rawRows =
        result && Array.isArray(result.models) ? result.models : [];
      const models = [];
      for (const row of rawRows) {
        if (!row || typeof row !== "object") continue;
        const provider = cleanNonEmptyString(row.provider);
        const id = cleanNonEmptyString(row.id);
        if (!provider || !id) continue;
        const mapped = { provider, id };
        if (typeof row.name === "string") mapped.name = row.name;
        if (
          Number.isFinite(row.contextWindow) &&
          row.contextWindow > 0
        ) {
          mapped.contextWindow = Math.floor(row.contextWindow);
        }
        if (typeof row.reasoning === "boolean") {
          mapped.reasoning = row.reasoning;
        }
        models.push(mapped);
      }
      return { models };
    },

    async "config.get"(params) {

      const result = await link.request(
        LINK_GW_METHODS.modelsConfigured,
        profileReadParams(params),
      );
      const defaultRef = buildModelRef(result && result.default);
      const fallbacks = [];
      for (const bucket of [
        result && result.fallbacks,
        result && result.channelOverrides,
      ]) {
        const rows = Array.isArray(bucket) ? bucket : [];
        for (const row of rows) {
          const ref = buildModelRef(row);
          if (ref) fallbacks.push(ref);
        }
      }
      const defaults = {};
      if (defaultRef || fallbacks.length) {
        defaults.model = { ...(defaultRef ? { primary: defaultRef } : {}), fallbacks };
      }
      defaults.models = {};
      return { config: { agents: { defaults } } };
    },

    async "usage.status"(params) {

      const result = await link.request(
        LINK_GW_METHODS.usageStatus,
        profileReadParams(params),
      );
      const updatedAt =
        result && Number.isFinite(result.updatedAt)
          ? Math.floor(result.updatedAt * 1000)
          : Date.now();
      const rawProviders =
        result && Array.isArray(result.providers) ? result.providers : [];
      const providers = [];
      for (const providerRow of rawProviders) {
        if (!providerRow || typeof providerRow !== "object") continue;
        const provider = cleanNonEmptyString(providerRow.provider);
        if (!provider) continue;
        const mapped = { provider, windows: [] };
        const displayName = cleanNonEmptyString(providerRow.displayName);
        if (displayName) mapped.displayName = displayName;
        const unavailableReason = cleanNonEmptyString(providerRow.unavailableReason);
        if (unavailableReason) Object.assign(mapped, { unavailableReason });
        const windows = Array.isArray(providerRow.windows)
          ? providerRow.windows
          : [];
        for (const window of windows) {
          if (!window || typeof window !== "object") continue;
          if (typeof window.label !== "string") continue;
          const shaped = { label: alignUsageWindowLabel(window.label) };
          if (!Number.isFinite(window.usedPercent)) continue;
          shaped.usedPercent = window.usedPercent;
          if (Number.isFinite(window.resetAt)) {
            shaped.resetAt = Math.floor(window.resetAt * 1000);
          }
          mapped.windows.push(shaped);
        }
        providers.push(mapped);
      }
      return { updatedAt, providers };
    },

    async "models.authStatus"() {

      const result = await link.request(LINK_GW_METHODS.authStatus, {});
      const rawProviders =
        result && Array.isArray(result.providers) ? result.providers : [];
      const providers = [];
      for (const providerRow of rawProviders) {
        if (!providerRow || typeof providerRow !== "object") continue;
        const provider = cleanNonEmptyString(providerRow.provider);
        if (!provider || !Array.isArray(providerRow.profiles)) continue;
        const profiles = [];
        for (const profile of providerRow.profiles) {
          if (!profile || typeof profile !== "object") continue;
          if (typeof profile.type !== "string") continue;
          profiles.push({ type: profile.type });
        }
        providers.push({ provider, profiles });
      }
      return { providers };
    },

    async "agent.identity.get"(params) {

      const parsed = parseHermesPublicKey(
        params && typeof params.sessionKey === "string" ? params.sessionKey : "",
      );
      const ns = parsed ? parsed.namespace : DEFAULT_HERMES_NAMESPACE;
      const result = await link.request(LINK_GW_METHODS.agentIdentity, { ns });
      const identity

        = {};
      if (result && typeof result.agentId === "string") {
        identity.agentId = result.agentId;
      }
      if (result && typeof result.name === "string") {
        identity.name = result.name;
      }
      if (result && typeof result.emoji === "string" && result.emoji.trim()) {
        identity.emoji = result.emoji;
      }
      const appearance = !identity.emoji && normalizeAgentAppearance(result && result.appearance);
      if (appearance) identity.appearance = appearance;
      if (result && typeof result.avatar === "string" && result.avatar.trim()) {
        identity.avatar = result.avatar;
      }
      return identity;
    },

    async "agents.list"() {

      const result = await link.request(LINK_GW_METHODS.profilesList, {});
      const rawProfiles =
        result && Array.isArray(result.profiles) ? result.profiles : [];
      const agents = [];
      for (const profile of rawProfiles) {
        if (!profile || typeof profile !== "object") continue;
        const name = cleanNonEmptyString(profile.name);
        if (!name) continue;
        const displayName = cleanNonEmptyString(profile.displayName);

        const emoji = cleanNonEmptyString(profile.emoji);
        const avatar = cleanNonEmptyString(profile.avatar);
        const appearance = !emoji && normalizeAgentAppearance(profile.appearance);

        const description = cleanNonEmptyString(profile.description);
        const row = {
          id: name,
          name: displayName || name,
          ...(emoji || avatar || appearance ? { identity: {
            ...(emoji ? { emoji } : {}), ...(avatar ? { avatar } : {}), ...(appearance ? { appearance } : {}),
          } } : {}),
          ...(description ? { description } : {}),
          ...(description && profile.descriptionAuto === true ? { descriptionAuto: true } : {}),
        };
        const model = cleanNonEmptyString(profile.model);
        if (model) {
          const provider = cleanNonEmptyString(profile.provider);
          row.model = {
            primary: provider ? `${provider}/${model}` : model,
          };
        }
        agents.push(row);
      }
      return {
        agents,
        defaultId: cleanNonEmptyString(result && result.defaultProfile) || "default",
        mainKey: null,
        scope: null,
        hermesProfileCreate: result && result.createSupported === true,
        agentCreateSetup: result && result.setupSupported === true,
        hermesProfileEmojiSet: true,
        hermesProfileSettings: result && result.settingsSupported === true,

        foreignSessionAdopt: result && result.adoptSupported === true,

        sharedChats: result && result.sharedChats === true,

        autoRoute: result && result.autoRoute === true,

        ...(result && result.desktopFleet ? { hermesFleet: result.desktopFleet } : {}),
      };
    },

    async "profiles.create"(params     ) {
      const name = cleanNonEmptyString(params && params.name);
      if (!name) {
        throw Object.assign(new Error("Enter a name for the agent."), { code: "invalid_name" });
      }
      let result;
      try {
        result = await link.request(LINK_GW_METHODS.profilesCreate, {
          name, ...(params?.setup != null ? { setup: params.setup, requestId: params.requestId } : {}),
        });
      } catch (error     ) {
        throw profileCreateError(error, name);
      }
      if (!result || !["created", "partial"].includes(result.status)) {
        const message = cleanNonEmptyString(result && result.error);
        throw new Error(message || "Hermes returned an invalid profile-create result");
      }
      const rawProfile =
        result.profile && typeof result.profile === "object" ? result.profile : {};
      const id = cleanNonEmptyString(rawProfile.id);
      const profileName = cleanNonEmptyString(rawProfile.name);
      if (!id || !profileName) {
        throw new Error("Hermes returned an invalid created profile");
      }

      const restartRequired = result.restartRequired === false ? false : true;
      return {
        status: result.status,
        profile: { id, name: profileName },
        restartRequired,
        ...(result.errorMessage ? { errorCode: "setup_incomplete", errorMessage: result.errorMessage } : {}),
      };
    },

    async "profiles.emoji.set"(params     ) {
      const profileId = cleanNonEmptyString(params && params.profileId);
      if (!profileId) throw new Error("profile id is required");
      const rawEmoji = params && params.emoji;
      const emoji = rawEmoji == null ? null : cleanNonEmptyString(rawEmoji);
      const result = await link.request(LINK_GW_METHODS.profilesEmojiSet, {
        profileId,
        emoji,
      });
      if (!result || result.status !== "updated") {
        const message = cleanNonEmptyString(result && result.error);
        throw new Error(message || "Hermes returned an invalid emoji-update result");
      }
      const rawProfile =
        result.profile && typeof result.profile === "object" ? result.profile : {};
      const id = cleanNonEmptyString(rawProfile.id);
      if (!id || id !== profileId) {
        throw new Error("Hermes returned an invalid updated profile");
      }
      return {
        status: "updated",
        backend: "hermes",
        agentId: id,
        emoji: cleanNonEmptyString(result.emoji),
      };
    },

    async "agents.route"(params     ) {

      const text = typeof params?.text === "string" ? params.text : "";
      const fallbackAgentRef = cleanNonEmptyString(params && params.fallbackAgentRef);
      const requestId = cleanNonEmptyString(params && params.requestId);
      const result = await link.request(LINK_GW_METHODS.agentsRoute, {
        text,
        ...(requestId ? { requestId } : {}),
        ...(fallbackAgentRef ? { fallbackAgentRef } : {}),
      }, AGENTS_ROUTE_TIMEOUT);
      if (!result || result.status !== "ok") {
        const code = cleanNonEmptyString(result && result.error) || "route_failed";
        throw Object.assign(new Error("Auto could not pick an agent."), { code });
      }
      const agentRef = cleanNonEmptyString(result.agentRef);
      const reason = AGENT_ROUTE_REASONS.has(result.reason) ? result.reason : null;
      if (!agentRef || !reason) throw Object.assign(new Error("Hermes returned an invalid route."), { code: "route_failed" });
      const latencyMs = Number.isFinite(result.latencyMs) && result.latencyMs >= 0 ? Math.round(result.latencyMs) : 0;
      return { agentRef, reason, latencyMs };
    },

    async "profiles.description.set"(params     ) {

      const profileId = cleanNonEmptyString(params && params.profileId);
      if (!profileId) throw Object.assign(new Error("Choose an agent."), { code: "invalid_agent_id" });
      const description = typeof params?.description === "string" ? params.description.trim() : "";
      if (description.length > AGENT_DESCRIPTION_SET_MAX_CHARS) {
        throw Object.assign(new Error("Keep it to one or two sentences."), { code: "invalid_description" });
      }
      const result = await link.request(LINK_GW_METHODS.profilesDescriptionSet, { profileId, description });
      const id = cleanNonEmptyString(result && result.profile && result.profile.id);
      if (!result || result.status !== "updated" || id !== profileId) {
        throw Object.assign(new Error("Hermes did not save the description."), { code: "update_failed" });
      }
      return {
        status: "updated",
        agentId: id,
        description: typeof result.description === "string" ? result.description : "",
      };
    },

    async "profiles.description.auto"(params     ) {

      const profileIds = Array.isArray(params?.profileIds)
        ? Array.from(new Set(params.profileIds.map(cleanNonEmptyString).filter(Boolean))).slice(0, AGENT_DESCRIBE_MAX_PROFILES)
        : [];
      if (!profileIds.length) throw Object.assign(new Error("Choose an agent."), { code: "invalid_agent_id" });
      const result = await link.request(LINK_GW_METHODS.profilesDescriptionAuto, { profileIds }, AGENT_DESCRIBE_TIMEOUT);
      if (!result || result.status !== "ok" || !Array.isArray(result.results)) {
        throw Object.assign(new Error("Hermes could not write the descriptions."), { code: "describe_failed" });
      }
      const results = [];
      for (const row of result.results) {
        const agentId = cleanNonEmptyString(row && row.profileId);
        if (!agentId || !profileIds.includes(agentId)) continue;
        const ok = row.ok === true && typeof row.description === "string" && !!row.description.trim();
        results.push({
          agentId,
          ok,
          ...(ok ? { description: row.description.trim() } : {}),
          ...(!ok && typeof row.reason === "string" && row.reason ? { reason: row.reason } : {}),
        });
      }
      return { status: "ok", results };
    },

    async "hermes.management"(params     ) {
      const identity = managementRequest(params);
      if (!validManagementRequest(identity)) throw new Error("Invalid Hermes management request");
      const result = await link.request(LINK_GW_METHODS.hermesManagement, identity, DB_READ_TIMEOUT);
      const out = managementResult(identity, result);

      if (identity.operation === "automations.starters" && Array.isArray(out?.automations?.starters)) {
        out.automations.starters = withStarterCards(out.automations.starters);
      }
      return out;
    },

    async "optional.setup"(params     ) {
      return link.request("gw.optional.setup", params, DB_READ_TIMEOUT);
    },

    async "tts.capabilities"() {
      return link.request("gw.tts.capabilities", {}, { timeoutMs: 10_000 });
    },

    async "tts.speakFile"(params     ) {
      return link.request("gw.tts.speak", {
        text: params?.text,
        outputPath: params?.outputPath,
        ...(params?.voice ? { voice: params.voice } : {}),
      }, { timeoutMs: 60_000 });
    },

    async "optional.setup.disconnect"(params     ) {
      return link.request("gw.optional.setup.disconnect", { context: { connectionId: params?.connectionId } }, DB_READ_TIMEOUT);
    },

    async "profiles.settings.get"(params     ) {
      const profileId = cleanNonEmptyString(params && params.profileId);
      if (!profileId) throw new Error("profile id is required");
      return link.request(LINK_GW_METHODS.profilesSettingsGet, { profileId });
    },

    async "profiles.settings.set"(params     ) {
      const profileId = cleanNonEmptyString(params && params.profileId);
      if (!profileId) throw new Error("profile id is required");
      return link.request(LINK_GW_METHODS.profilesSettingsSet, {
        profileId,
        emoji: params?.emoji == null ? null : params.emoji,
        setup: params?.setup,
        producedAtMs: params?.producedAtMs,
        expiresAtMs: params?.expiresAtMs,
      });
    },

    async "agents.files.get"(params) {

      const name = params && params.name;
      if (name !== "IDENTITY.md") {
        throw new Error(`unsupported workspace file: ${name}`);
      }
      const result = await link.request(LINK_GW_METHODS.profilesSoul, {
        profile: String((params && params.agentId) || ""),
      });
      return {
        file: {
          content: String(result && result.content != null ? result.content : ""),
        },
      };
    },

    async "skills.status"() {

      const result = await link.request(LINK_GW_METHODS.skillsStatus, {});
      const rawRows =
        result && Array.isArray(result.skills) ? result.skills : [];
      const skills = [];
      for (const row of rawRows) {
        if (!row || typeof row !== "object") continue;
        const name = cleanNonEmptyString(row.name);
        if (!name) continue;
        skills.push({
          name,
          description: typeof row.description === "string" ? row.description : "",
          eligible: true,
        });
      }
      return { skills };
    },

    async "starmap.graph"(params     ) {

      const requested = cleanNonEmptyString(params && params.agentId) || "";
      const profile = requested.toLowerCase() === "main" ? "" : requested;
      let result     ;
      try {
        result = await link.request(LINK_GW_METHODS.starMapGraph, { profile }, DB_READ_TIMEOUT);
      } catch (err) {
        if (isStarMapMethodNotFound(err)) throw createStarMapUnsupportedError("gw.starmap.graph");
        throw err;
      }
      if (!result || typeof result !== "object") {
        const err      = new Error("star map reply was not an object");
        err.code = "starmap_bad_reply";
        throw err;
      }
      if (result.status === "unsupported") throw createStarMapUnsupportedError("hermes host");

      const failed =
        result.status === "error" ||
        (result.error !== undefined && result.error !== null && result.error !== false);
      if (failed) {
        const code =
          result.errorCode ??
          result.code ??
          (result.error && typeof result.error === "object" ? result.error.code : undefined);
        if (code === "unsupported" || code === METHOD_NOT_FOUND_CODE) {
          throw createStarMapUnsupportedError("hermes host");
        }
        const err      = new Error("star map read failed");
        err.code = typeof code === "string" && code.trim() ? code.trim() : "starmap_failed";
        throw err;
      }
      if (result.status !== undefined && result.status !== "ok") {
        const err      = new Error("star map read failed");
        err.code = "starmap_failed";
        throw err;
      }
      const graph = normalizeStarMapGraph(result);
      return { backend: "hermes", nodes: graph.nodes, links: graph.links };
    },

    async "starmap.forget"(params     ) {

      const parsed = parseStarMapForgetParams(params);
      if (!parsed) throw createStarMapForgetError("bad_request");
      const profile = parsed.agentId.toLowerCase() === "main" ? "" : parsed.agentId;
      let result     ;
      try {
        result = await link.request(
          LINK_GW_METHODS.starMapForget,
          { profile, id: parsed.id, kind: parsed.kind, text: parsed.text },
          DB_READ_TIMEOUT,
        );
      } catch (err) {
        if (isStarMapMethodNotFound(err)) throw createStarMapUnsupportedError("gw.starmap.forget");
        throw err;
      }
      if (!result || typeof result !== "object") throw createStarMapForgetError("forget_failed");
      if (result.status === "unsupported") throw createStarMapUnsupportedError("hermes host");
      if (result.status === "error") {
        const code = typeof result.errorCode === "string" ? result.errorCode.trim() : "";
        if (code === "unsupported") throw createStarMapUnsupportedError("hermes host");
        const message = typeof result.message === "string" ? result.message : undefined;
        throw createStarMapForgetError(code || "forget_failed", message);
      }
      if (result.status === "ok" && (result.action === "removed" || result.action === "archived" || result.action === "turned_off")) {
        return { action: result.action };
      }
      throw createStarMapForgetError("forget_failed");
    },

    async "commands.list"() {

      const result = await link.request(LINK_GW_METHODS.commandsList, {});
      const rawRows =
        result && Array.isArray(result.commands) ? result.commands : [];
      const commands = [];
      for (const row of rawRows) {
        if (!row || typeof row !== "object") continue;
        const name = cleanNonEmptyString(row.name);
        if (!name) continue;
        const argsHint = cleanNonEmptyString(row.argsHint);

        const textAliases = [];
        if (Array.isArray(row.aliases)) {
          for (const raw of row.aliases) {
            const alias = cleanNonEmptyString(raw);
            if (!alias || alias === name) continue;
            const slashed = `/${alias}`;
            if (!textAliases.includes(slashed)) textAliases.push(slashed);
          }
        }
        const entry = {
          name,
          nativeName: name,
          textAliases,
          description:
            typeof row.description === "string" ? row.description : "",
          source: row.source === "plugin" ? "plugin" : "native",
          scope: "text",
          acceptsArgs: Boolean(argsHint),
          noTrailingSpace: row.noTrailingSpace === true,
          availability: row.busyPolicy === "reject" ? "busy-blocked" : "ready",
        };
        const category = cleanNonEmptyString(row.category);
        const mapped =
          category && hasOwn(HERMES_COMMAND_CATEGORY, category)
            ? HERMES_COMMAND_CATEGORY[category]
            : null;
        if (mapped) entry.category = mapped;
        if (argsHint) entry.argsHint = argsHint;

        const choices = Array.isArray(row.subcommands)
          ? row.subcommands
              .map((raw) => cleanNonEmptyString(raw))
              .filter((value) => value !== null)
              .map((value) => ({ value, label: value }))
          : [];
        if (choices.length) {
          entry.args = [
            {
              name: "subcommand",
              description: "",
              type: "string",
              required: false,
              choices,
            },
          ];
        }
        commands.push(entry);
      }
      return { commands };
    },

    async "sessions.compact"(params) {

      const ack = await dispatchTurn({
        message: "/compress",
        sessionKey: params && params.key,
      });
      if (ack.status && ack.status !== "accepted") {
        throw new Error(ack.error || `compaction dispatch ${ack.status}`);
      }
      return {};
    },

    async "sessions.copy"(params) {
      const sourceKey = cleanNonEmptyString(params && params.key);
      if (!sourceKey) throw new Error("sessions.copy requires key");
      if (!isForeignHermesSessionKey(sourceKey)) {
        throw new Error("sessions.copy requires a foreign Hermes source key");
      }
      const targetKey =
        cleanNonEmptyString(
          (params && params.targetKey) || (params && params.sessionKey),
        ) || defaultCopyTargetKey();
      const target = keyToMintedTarget(targetKey, "targetKey");
      const result = await link.request(LINK_FOREIGN_METHODS.copy, {
        identity: keyToIdentity(sourceKey),
        publicKey: sourceKey,
        target: target.target,
        targetPublicKey: target.publicKey,
      });
      const response = {
        status: cleanNonEmptyString(result && result.status) || "accepted",
        key: copiedSessionPublicKey(result && result.session, target.publicKey),
        copiedFrom: sourceKey,
      };
      if (result && result.session) response.session = result.session;
      const error = cleanNonEmptyString(result && result.error);
      if (error) response.error = error;
      return response;
    },

    async "sessions.adopt"(params     ) {
      const sourceKey = cleanNonEmptyString(params && params.key);
      if (!sourceKey) throw new Error("sessions.adopt requires key");
      if (!isAdoptableHermesSessionKey(sourceKey)) {
        throw new Error(
          "sessions.adopt requires a Desktop, CLI or TUI Hermes source key",
        );
      }
      const linkParams      = {
        identity: keyToIdentity(sourceKey),
        publicKey: sourceKey,
      };
      if (params && params.takeOver === true) linkParams.takeOver = true;
      const result = await link.request(
        LINK_FOREIGN_METHODS.adopt,
        linkParams,
        ADOPT_TIMEOUT_MS,
      );
      const response      = {
        status: cleanNonEmptyString(result && result.status) || "accepted",
        key: copiedSessionPublicKey(result && result.session, ""),
        adoptedFrom: sourceKey,
      };
      if (result && result.session) response.session = result.session;
      const verdict = cleanNonEmptyString(result && result.verdict);
      const error = cleanNonEmptyString(result && result.error) || verdict;
      if (error) response.error = error;
      if (verdict) response.verdict = verdict;
      const holdState = cleanNonEmptyString(result && result.holdState);
      if (holdState) response.holdState = holdState;
      if (response.status === "accepted" && !response.key) {

        throw new Error("sessions.adopt returned no adopted session key");
      }
      return response;
    },

    async "sessions.driver"(params     ) {
      const key = cleanNonEmptyString(params && params.key);
      if (!key) throw new Error("sessions.driver requires key");
      const result = await link.request(LINK_FOREIGN_METHODS.driver, {
        identity: keyToIdentity(key),
        publicKey: key,
      });
      return {
        status: cleanNonEmptyString(result && result.status) || "ok",
        key,
        state: cleanNonEmptyString(result && result.state) || "glasses_drive",
        holdState: cleanNonEmptyString(result && result.holdState),
        hold: result && result.hold && typeof result.hold === "object" ? result.hold : null,
        inflight:
          result && result.inflight && typeof result.inflight === "object"
            ? { active: result.inflight.active === true, platform: cleanNonEmptyString(result.inflight.platform) }
            : { active: false, platform: null },
        lineage: Array.isArray(result && result.lineage) ? result.lineage.map(String) : [],
        sessionId: cleanNonEmptyString(result && result.sessionId),
        hermesHome: cleanNonEmptyString(result && result.hermesHome),
        watch: result && result.watch && typeof result.watch === "object" ? result.watch : null,
      };
    },

    async "sessions.list"(params) {
      const linkParams = {};
      const limit = toFiniteNumber(params && params.limit);
      if (limit !== null && limit > 0) linkParams.limit = Math.floor(limit);
      const search =
        params && typeof params.search === "string" ? params.search.trim() : "";
      if (search) {

        const parsedKey = parseHermesPublicKey(search);
        if (parsedKey) {
          linkParams.keyIdentity =
            parsedKey.kind === "minted"
              ? { ns: parsedKey.namespace, chatId: parsedKey.chatId }
              : { ns: parsedKey.namespace, remainder: parsedKey.remainder };
        } else {
          linkParams.search = search;
        }
      }

      const result = await link.request(LINK_DB_METHODS.sessionsList, linkParams, DB_READ_TIMEOUT);
      const rawRows =
        result && Array.isArray(result.sessions) ? result.sessions : [];
      const sessions = [];
      for (const row of rawRows) {
        const mapped = mapListRow(row);
        if (mapped) {
          sessions.push(mapped);
          rememberNativeIds(row, mapped.key);
          if (row.attention && row.attention.sessionKey === mapped.key) {
            dispatchBackendEvent("sessionAttention", row.attention);
          }
        }
      }
      return { sessions };
    },

    async "sessions.attention"(params     ) {
      const key = cleanNonEmptyString(params && params.key);
      if (!key || !parseHermesPublicKey(key)) throw new Error("sessions.attention requires a Hermes key");

      await translators["sessions.list"]({ search: key, limit: 1 });
      return { status: "observed" };
    },

    async "sessions.search"(params     ) {
      const query =
        params && typeof params.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("sessions.search requires a query");
      const linkParams      = { query };
      const limit = toFiniteNumber(params && params.limit);
      if (limit !== null && limit > 0) linkParams.limit = Math.floor(limit);
      const result = await link.request(LINK_DB_METHODS.sessionsSearch, linkParams, DB_READ_TIMEOUT);
      const rawMatches =
        result && Array.isArray(result.matches) ? result.matches : [];
      const snippets = [];
      for (const raw of rawMatches) {
        const session = mapListRow(raw && raw.session);
        if (!session) continue;
        snippets.push({
          sessionKey: session.key,
          role: typeof raw.role === "string" ? raw.role : "",
          updatedAtMs: session.updatedAt || 0,
          ...splitSearchSnippet(raw.snippet, query),
        });
      }
      return {
        snippets,
        truncated: !!(result && result.truncated),
        unavailable: !!(result && result.available === false),
        unavailableReason:
          result && typeof result.reason === "string" ? result.reason : null,
      };
    },

    async "sessions.resolve"(params) {
      const key =
        params && typeof params.key === "string" ? params.key.trim() : "";
      if (!key) throw new Error("sessions.resolve requires a key");

      if (isHermesSessionKey(key)) return { key };
      const ns =
        params && typeof params.ns === "string" ? params.ns.trim() : "";
      const result = await link.request(LINK_DB_METHODS.resolveKey, {
        key,
        ...(ns ? { ns } : {}),
      }, DB_READ_TIMEOUT);
      const derived = deriveHermesPublicKey(result && result.row);
      if (!derived) throw new Error(`no such session: ${key}`);
      return { key: derived.key };
    },

    async "sessions.patch"(params) {

      const hasRead = hasOwn(params, "read");
      const hasHidden = hasOwn(params, "hidden");
      if (hasRead || hasHidden) {
        if (!sessionReadStateSupported()) {

          throw methodNotFoundError(
            hasRead ? LINK_DB_METHODS.setRead : LINK_DB_METHODS.setHidden,
          );
        }

        const identity = keyToIdentity(params && params.key);
        let result = { ok: true };
        if (hasRead) {
          result = await link.request(LINK_DB_METHODS.setRead, {
            identity,
            read: params.read !== false,
          });
        }
        if (hasHidden) {
          result = await link.request(LINK_DB_METHODS.setHidden, {
            identity,
            hidden: params.hidden === true,
          });
        }
        return result;
      }
      if (params && Object.prototype.hasOwnProperty.call(params, "label")) {

        keyToIdentity(params.key);
        const target = keyToMintedTarget(
          params.key,
          "key",
          "foreign hermes session keys cannot be renamed (only OcuClaw-minted sessions may be renamed)",
        );
        const label =
          typeof params.label === "string" && params.label.trim()
            ? params.label.trim()
            : null;
        return link.request(LINK_DB_METHODS.setTitle, {
          identity: target.target,
          title: label,
        });
      }

      const target = keyToMintedTarget(
        params && params.key,
        "key",
        "foreign hermes session keys cannot be configured (only OcuClaw-minted sessions may be configured)",
      );
      const options = {
        confirm_model_selection: !!(params && params.confirmModelSelection === true),
        initial: !!(params && params.initial === true),
      };
      const commands = [];
      let showReasoning                 = null;
      if (hasOwn(params, "model") || hasOwn(params, "modelProvider")) {
        const modelText =
          params && params.model != null ? String(params.model).trim() : "";
        if (!modelText) {
          Reflect.set(options, "model", "");
        } else {
          let provider = null;
          let id = modelText;
          if (modelText.indexOf("/") !== -1) {
            const slashIdx = modelText.indexOf("/");
            const splitProvider = modelText.slice(0, slashIdx).trim();
            const splitModel = modelText.slice(slashIdx + 1).trim();
            if (splitProvider) provider = splitProvider;
            id = splitModel || modelText;
          }
          const explicitProvider =
            params && typeof params.modelProvider === "string"
              ? params.modelProvider.trim()
              : "";
          if (explicitProvider) provider = explicitProvider;
          if (params.oneTurn === true) {
            let command = `/model ${id}`;
            if (provider) command += ` --provider ${provider}`;
            commands.push(`${command} --once`);
          } else {
            Reflect.set(options, "model", id);
            if (provider) Reflect.set(options, "provider", provider);
          }
        }
      }
      if (hasOwn(params, "thinkingLevel")) {
        const raw =
          params && params.thinkingLevel != null
            ? String(params.thinkingLevel).trim().toLowerCase()
            : "";
        if (!raw) {
          Reflect.set(options, "reasoning_effort", "");
        } else {
          const hermesLevel = THINKING_TO_HERMES_LEVEL[raw];
          if (!hermesLevel) {
            throw new Error(`unsupported thinking level: ${raw}`);
          }
          Reflect.set(options, "reasoning_effort", hermesLevel);
        }
      }
      if (hasOwn(params, "fastMode")) {
        if (typeof params.fastMode !== "boolean") {
          throw new Error("fastMode must be a boolean");
        }
        Reflect.set(options, "fast", params.fastMode);
      }
      if (hasOwn(params, "reasoningLevel")) {
        const raw =
          params && params.reasoningLevel != null
            ? String(params.reasoningLevel).trim().toLowerCase()
            : "";
        if (!hasOwn(REASONING_DISPLAY_TO_SHOW_REASONING, raw)) {
          throw new Error(`unsupported reasoning level: ${raw || "<blank>"}`);
        }
        showReasoning = REASONING_DISPLAY_TO_SHOW_REASONING[raw];
      }
      let structured = null;
      let structuredFallback = null;
      if (Object.keys(options).some((key) => !["confirm_model_selection", "initial"].includes(key))) {

        const { pending } = await serializeSend(target.publicKey, () => ({
          pending: issueRequest(LINK_SESSION_METHODS.optionsApply, {
            sessionKey: target.publicKey,
            target: target.target,
            options,
          }),
        }));
        structured = await pending;
        if (structured && structured.status === "unsupported") {

          const fallback = sessionOptionsFallbackCommands(options);
          logger.warn(
            `[hermes-bridge] structured session options unsupported on this Hermes; falling back to ${fallback.join(", ")}`,
          );
          commands.unshift(...fallback);
          structuredFallback = "slash_commands";
          structured = null;
        } else if (!structured || structured.status !== "accepted") {
          throw new Error(
            (structured && structured.error) ||
              `structured session options ${structured && structured.status ? structured.status : "failed"}`,
          );
        }
      }
      const results = [];
      for (const command of commands) {
        const ack = await dispatchTurn({
          message: command,
          sessionKey: params && params.key,

          ...(isQuietSettingsCommand(command) ? { quiet: true } : {}),
        });
        if (ack.status && ack.status !== "accepted") {
          throw new Error(ack.error || `settings command ${ack.status}`);
        }
        results.push(ack);
      }
      let reasoningApplied = null;
      if (showReasoning !== null) {

        const profile = await link.request(LINK_PROFILE_METHODS.optionsApply, {
          ns: keyToIdentity(target.publicKey).ns,
          options: { show_reasoning: showReasoning },
        });
        if (profile && profile.status && profile.status !== "accepted" && profile.error) {
          throw new Error(profile.error);
        }
        if (!profile || (profile.status && profile.status !== "accepted") ||
          profile.reasoningLevel !== String(params.reasoningLevel).trim().toLowerCase()) {
          throw new Error("Hermes reasoning visibility could not be confirmed; reopen settings to refresh native state");
        }
        reasoningApplied = { reasoningLevel: profile.reasoningLevel };
      }
      return {
        ok: true,
        commands,
        results,
        structured,
        ...(structuredFallback ? { fallback: structuredFallback } : {}),
        ...(reasoningApplied || (structured && structured.effective)
          ? { applied: { ...(structured?.effective || {}), ...reasoningApplied } }
          : {}),
      };
    },

    async "sessions.delete"(params) {

      const target = keyToMintedTarget(
        params && params.key,
        "key",
        "foreign hermes session keys cannot be deleted (only OcuClaw-minted sessions may be deleted)",
      );
      return link.request(LINK_DB_METHODS.deleteSession, {
        identity: target.target,
      });
    },

    async "chat.history"(params     ) {
      const limit = toFiniteNumber(params && params.limit);

      const afterId = toFiniteNumber(params && params.afterId);
      const linkParams = {
        identity: keyToIdentity(params && params.sessionKey),

        ...(limit !== null && limit > 0 ? { limit: Math.floor(limit) } : {}),
        ...(afterId !== null && afterId >= 0 ? { afterId: Math.floor(afterId) } : {}),

        ...(afterId !== null && afterId >= 0 && params && params.order === "oldest"
          ? { order: "oldest" }
          : {}),
      };
      const result = await link.request(LINK_DB_METHODS.chatHistory, linkParams, DB_READ_TIMEOUT);
      const messages = shapeConversationMessages(
        result && result.messages,
        limit === null ? undefined : limit,
      );

      const rawTotal = result ? result.total : undefined;
      const total = rawTotal == null ? null : toFiniteNumber(rawTotal);
      const rawNextAfterId = result ? result.nextAfterId : undefined;
      const nextAfterId = rawNextAfterId == null ? null : toFiniteNumber(rawNextAfterId);
      return {
        messages,
        ...(total !== null && total >= 0 ? { total: Math.floor(total) } : {}),
        ...(result && result.rowIdsUnavailable === true ? { rowIdsUnavailable: true } : {}),
        ...(nextAfterId !== null && nextAfterId >= 0 ? { nextAfterId: Math.floor(nextAfterId) } : {}),
      };
    },

    async "chat.watermark"(params     ) {
      const key = cleanNonEmptyString(params && params.sessionKey);
      if (!key) throw new Error("chat.watermark requires sessionKey");
      const result = await link.request(
        LINK_DB_METHODS.chatWatermark,
        { identity: keyToIdentity(key) },
        DB_READ_TIMEOUT,
      );

      const rawWatermark = result ? result.watermark : undefined;
      const watermark = rawWatermark == null ? null : toFiniteNumber(rawWatermark);
      return {
        sessionKey: key,
        sessionId: cleanNonEmptyString(result && result.sessionId),
        watermark: watermark !== null && watermark >= 0 ? Math.floor(watermark) : null,
        dbPath: cleanNonEmptyString(result && result.dbPath),
        hermesHome: cleanNonEmptyString(result && result.hermesHome),
        inflight:
          result && result.inflight && typeof result.inflight === "object"
            ? { active: result.inflight.active === true, platform: cleanNonEmptyString(result.inflight.platform) }
            : { active: false, platform: null },
      };
    },

    async "sessions.describe"(params) {
      const result = await link.request(LINK_DB_METHODS.describeSession, {
        identity: keyToIdentity(params && params.key),
      }, DB_READ_TIMEOUT);

      const rawLastTurn = result && result.lastMessageTokenCount;
      const lastTurn =
        typeof rawLastTurn === "number" && Number.isFinite(rawLastTurn)
          ? rawLastTurn
          : null;
      const contextTokensKnown = lastTurn !== null && lastTurn >= 0;
      const totalTokens = contextTokensKnown ? Math.floor(lastTurn) : 0;

      const contextTokensEstimated =
        contextTokensKnown && result.lastMessageTokenCountEstimated === true;

      const rawWindow = result ? result.contextWindow : undefined;
      const window = rawWindow == null ? null : toFiniteNumber(rawWindow);
      const contextTokens = window !== null && window > 0 ? Math.floor(window) : 0;

      const rawCount = result ? result.messageCount : undefined;
      const messageCount = rawCount == null ? null : toFiniteNumber(rawCount);

      const rawCost = result ? result.costUsd : undefined;
      const costUsd = rawCost == null ? null : toFiniteNumber(rawCost);
      return {
        session: {
          totalTokens,
          contextTokens,
          contextTokensKnown,
          ...(contextTokensEstimated ? { contextTokensEstimated: true } : {}),
          ...(messageCount !== null && messageCount >= 0
            ? { messageCount: Math.floor(messageCount) }
            : {}),
          ...(costUsd !== null && costUsd >= 0 ? { costUsd } : {}),
        },
      };
    },

    async "sessions.compaction.list"(params) {
      const result = await link.request(LINK_DB_METHODS.compactionInfo, {
        identity: keyToIdentity(params && params.key),
      }, DB_READ_TIMEOUT);
      const hops = toFiniteNumber(result && result.hops);

      const compactions = toFiniteNumber(result && result.compactions);
      const counted = compactions !== null && compactions >= 0;
      const total = counted ? compactions : hops;
      const count = total !== null && total > 0 ? Math.floor(total) : 0;

      const checkpoints = [];
      for (let i = 0; i < count; i += 1) checkpoints.push({});
      return {
        checkpoints,
        metric: counted && result.exact === true ? "compactions" : "hops",

        ...(counted && result.live === true ? { live: true } : {}),
      };
    },
  };

  const listeners = new Map();

  function dispatchBackendEvent(name, payload) {

    if (isQuietRunEvent(name, payload)) return;
    const set = listeners.get(name);
    if (!set || set.size === 0) return;

    const normalized = name === SESSIONS_GONE_EVENT
      ? withGoneSessionKeys(payload)
      : normalizeHermesDisplayEventPayload(
        name,
        normalizeBackendEventPayload(payload),
      );
    for (const listener of Array.from(set)) {
      try {
        listener(normalized);
      } catch (err) {
        logger.warn(
          `[hermes-bridge] "${name}" listener threw: ${err && err.message ? err.message : err}`,
        );
      }
    }
  }

  function on(eventName, listener) {
    if (typeof listener !== "function") {
      throw new Error("bridge.on requires a listener function");
    }
    let set = listeners.get(eventName);
    if (!set) {
      set = new Set();
      listeners.set(eventName, set);
    }
    set.add(listener);
    return () => off(eventName, listener);
  }

  function off(eventName, listener) {
    const set = listeners.get(eventName);
    if (set) {
      set.delete(listener);
      if (set.size === 0) listeners.delete(eventName);
    }
  }

  function request(method, params) {
    const translator = Object.prototype.hasOwnProperty.call(translators, method)
      ? translators[method]
      : null;
    if (!translator) {
      return Promise.reject(methodNotFoundError(method));
    }
    try {
      return Promise.resolve(translator(params));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function sendMessage(text, sessionKey, attachment, requestOptions) {

    let params;
    try {
      params = buildAgentRequestParams(
        text,
        sessionKey,
        attachment,
        idempotencyKeyFactory,
        requestOptions,
      );
    } catch (err) {
      return Promise.reject(err);
    }
    return request("agent", params, { expectFinal: false });
  }

  const bridge = {
    kind: "hermes",

    start() {},
    stop() {},
    sendMessage,
    request,
    resolveApproval(id, decision, options = { reason: undefined }) {
      const approvalId = cleanNonEmptyString(id);
      if (!approvalId) {
        return Promise.reject(new Error("resolveApproval requires id"));
      }
      const approvalDecision = cleanNonEmptyString(decision);
      if (!approvalDecision) {
        return Promise.reject(new Error("resolveApproval requires decision"));
      }
      const reason = cleanNonEmptyString(options && options.reason);
      const params = reason
        ? {
            id: approvalId,
            decision: approvalDecision,
            reason: reason.slice(0, 500),
          }
        : { id: approvalId, decision: approvalDecision };
      return link.request(LINK_APPROVAL_RESOLVE_METHOD, params).then((result) => {
        const status =
          result && typeof result === "object" && typeof result.status === "string"
            ? result.status
            : "";
        if (status && status !== "accepted") {
          const reason =
            (result && typeof result.reason === "string" && result.reason) ||
            (result && typeof result.error === "string" && result.error) ||
            status;
          throw new Error(`approval resolve ${reason}`);
        }
        return result;
      });
    },
    on,
    off,

    rawClient: null,
  };

  return { bridge, dispatchBackendEvent };
}

module.exports = { LINK_DB_METHODS, HERMES_FEATURE_TOKEN_SESSION_READ_STATE, LINK_DB_READ_TIMEOUT_MS, LINK_ADOPT_TIMEOUT_MS, LINK_AGENTS_ROUTE_TIMEOUT_MS, LINK_AGENT_DESCRIBE_TIMEOUT_MS, AGENT_DESCRIPTION_SET_MAX_CHARS, AGENT_DESCRIBE_MAX_PROFILES, LINK_BACKEND_EVENT_METHOD, LINK_DISPATCH_METHOD, LINK_GW_METHODS, LINK_FOREIGN_METHODS, LINK_APPROVAL_RESOLVE_METHOD, LINK_APPROVAL_LLM_COMPLETE_METHOD, LINK_PROGRAM_CARD_REVIEW_LLM_COMPLETE_METHOD, LINK_PROGRAM_CARD_FRAME_LLM_COMPLETE_METHOD, LINK_APPROVAL_EXPLAIN_SETTING_METHOD, LINK_WAITING_SETTINGS_METHOD, LINK_WAITING_ANSWER_METHOD, LINK_CLARIFY_RESOLVE_METHOD, LINK_CLARIFY_AWAIT_TEXT_METHOD, LINK_SESSION_METHODS, LINK_PROFILE_METHODS, LINK_ATTACHMENT_INLINE_MAX_CHARS, DENIED_SESSION_SOURCES, SESSIONS_GONE_EVENT, normalizeBackendEventPayload, alignUsageWindowLabel, collapseHermesCommandConfirmation, translateHermesSkillSlash, COMPACTION_SUMMARY_OPENERS, MERGED_SUMMARY_DELIMITER, classifyCompactionSummary, createHermesGatewayBridge };
