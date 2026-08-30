const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { METHOD_NOT_FOUND_CODE } = require("../gateway/backend-contract.cjs");
const { buildAgentRequestParams } = require("../gateway/gateway-bridge.cjs");
const { DEFAULT_HERMES_NAMESPACE, deriveHermesPublicKey, isForeignHermesSessionKey, isHermesSessionKey, mintedHermesSessionKey, parseHermesPublicKey } = require("./hermes-session-keys.cjs");
const { normalizeHermesActivityToolPayload } = require("./hermes-activity-tool-shim.cjs");

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
});

const HERMES_FEATURE_TOKEN_SESSION_READ_STATE = "session_read_state";

function normalizeHermesFeatureTokenSet(raw) {
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

const LINK_BACKEND_EVENT_METHOD = "backend.event";

const LINK_DISPATCH_METHOD = "dispatch.send";

const LINK_GW_METHODS = Object.freeze({
  modelsList: "gw.models.list",
  modelsConfigured: "gw.models.configured",
  usageStatus: "gw.usage.status",
  authStatus: "gw.auth.status",
  agentIdentity: "gw.agent.identity",
  profilesList: "gw.profiles.list",
  profilesSoul: "gw.profiles.soul",
  skillsStatus: "gw.skills.status",
  commandsList: "gw.commands.list",
});

const LINK_FOREIGN_METHODS = Object.freeze({
  copy: "foreign.sessions.copy",
});

const LINK_APPROVAL_RESOLVE_METHOD = "approval.resolve";
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

const REASONING_DISPLAY_TO_HERMES_COMMANDS = Object.freeze({
  off: Object.freeze(["/reasoning hide"]),
  on: Object.freeze(["/reasoning show", "/reasoning clamp"]),
  "on.full": Object.freeze(["/reasoning show", "/reasoning full"]),
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
    prepare(attachments) {
      const descriptors = [];
      const spilled = [];
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
          const spillPath = path.join(
            os.tmpdir(),
            `ocuclaw-attach-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          );

          fs.writeFileSync(spillPath, Buffer.from(content, "base64"), {
            mode: 0o600,
            flag: "wx",
          });
          descriptor.path = spillPath;
          spilled.push(spillPath);
        } else {
          descriptor.content = content;
        }
        descriptors.push(descriptor);
      }
      return {
        descriptors,
        cleanup() {
          for (const spillPath of spilled) {
            try {
              fs.unlinkSync(spillPath);
            } catch {

            }
          }
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

    updatedAt:
      lastActiveSeconds === null ? 0 : Math.floor(lastActiveSeconds * 1000),
    ...(activityDescription
      ? { lastActivityDescription: activityDescription }
      : {}),
    ...(unread === null ? {} : { unread }),
    ...(hidden === null ? {} : { hidden }),
  };
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

  return mapped;
}

const COMPACTION_SUMMARY_OPENERS = Object.freeze([

  "[CONTEXT COMPACTION — REFERENCE ONLY]",

  "[CONTEXT SUMMARY]:",
]);

const MERGED_SUMMARY_DELIMITER =
  "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]";

function contentTextForSummaryClassification(content) {
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

function startsWithSummaryOpener(text) {
  for (const opener of COMPACTION_SUMMARY_OPENERS) {
    if (text.startsWith(opener)) return true;
  }
  return false;
}

function classifyCompactionSummary(content) {
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
  msg,
  role,
  content,
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

function splitSearchSnippet(rawSnippet, query) {
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

  function prepareAttachments(params, linkParams) {
    if (params && Array.isArray(params.attachments) && params.attachments.length > 0) {
      const prepared = attachmentTransport.prepare(params.attachments);
      if (prepared.descriptors.length > 0) {
        linkParams.attachments = prepared.descriptors;
      }
      return prepared;
    }
    return null;
  }

  async function dispatchTurn(params) {
    const runId = runIdFactory();
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
    const prepared = prepareAttachments(params, dispatchParams);
    let result;
    try {
      result = await link.request(LINK_DISPATCH_METHOD, dispatchParams);
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
      return link.request(LINK_SESSION_METHODS.abort, {
        sessionKey: route.publicKey,
        target: route.target,
      });
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
      const prepared = prepareAttachments(params, linkParams);
      let result;
      try {
        result = await link.request(LINK_SESSION_METHODS.steer, linkParams);
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

    async "clarify.resolve"(params) {
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

    async "clarify.await_text"(params) {
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

    async "models.list"() {

      const result = await link.request(LINK_GW_METHODS.modelsList, {});
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

    async "config.get"() {

      const result = await link.request(LINK_GW_METHODS.modelsConfigured, {});
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
      if (defaultRef) {
        defaults.model = { primary: defaultRef, fallbacks };
      }
      defaults.models = {};
      return { config: { agents: { defaults } } };
    },

    async "usage.status"() {

      const result = await link.request(LINK_GW_METHODS.usageStatus, {});
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
      const identity = {};
      if (result && typeof result.agentId === "string") {
        identity.agentId = result.agentId;
      }
      if (result && typeof result.name === "string") {
        identity.name = result.name;
      }
      if (result && typeof result.emoji === "string" && result.emoji.trim()) {
        identity.emoji = result.emoji;
      }
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
        const row = { id: name, name: displayName || name };
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
      };
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
        if (mapped) sessions.push(mapped);
      }
      return { sessions };
    },

    async "sessions.search"(params) {
      const query =
        params && typeof params.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("sessions.search requires a query");
      const linkParams = { query };
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
        const displayCommands = REASONING_DISPLAY_TO_HERMES_COMMANDS[raw];
        if (!displayCommands) {
          throw new Error(`unsupported reasoning level: ${raw || "<blank>"}`);
        }
        commands.push(...displayCommands);
      }
      let structured = null;
      if (Object.keys(options).some((key) => !["confirm_model_selection", "initial"].includes(key))) {
        structured = await link.request(LINK_SESSION_METHODS.optionsApply, {
          sessionKey: target.publicKey,
          target: target.target,
          options,
        });
        if (!structured || structured.status !== "accepted") {
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
        });
        if (ack.status && ack.status !== "accepted") {
          throw new Error(ack.error || `settings command ${ack.status}`);
        }
        results.push(ack);
      }
      return {
        ok: true,
        commands,
        results,
        structured,
        ...(structured && structured.effective
          ? { applied: structured.effective }
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

    async "chat.history"(params) {
      const limit = toFiniteNumber(params && params.limit);
      const linkParams = {
        identity: keyToIdentity(params && params.sessionKey),
      };

      if (limit !== null && limit > 0) linkParams.limit = Math.floor(limit);
      const result = await link.request(LINK_DB_METHODS.chatHistory, linkParams, DB_READ_TIMEOUT);
      const messages = shapeConversationMessages(
        result && result.messages,
        limit === null ? undefined : limit,
      );

      const rawTotal = result ? result.total : undefined;
      const total = rawTotal == null ? null : toFiniteNumber(rawTotal);
      return {
        messages,
        ...(total !== null && total >= 0 ? { total: Math.floor(total) } : {}),
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

      const rawCost = result ? result.costUsd : undefined;
      const costUsd = rawCost == null ? null : toFiniteNumber(rawCost);
      return {
        session: {
          totalTokens,
          contextTokens: 0,
          contextTokensKnown,
          ...(costUsd !== null && costUsd >= 0 ? { costUsd } : {}),
        },
      };
    },

    async "sessions.compaction.list"(params) {
      const result = await link.request(LINK_DB_METHODS.compactionInfo, {
        identity: keyToIdentity(params && params.key),
      }, DB_READ_TIMEOUT);
      const hops = toFiniteNumber(result && result.hops);
      const count = hops !== null && hops > 0 ? Math.floor(hops) : 0;

      const checkpoints = [];
      for (let i = 0; i < count; i += 1) checkpoints.push({});
      return { checkpoints, metric: "hops" };
    },
  };

  const listeners = new Map();

  function dispatchBackendEvent(name, payload) {
    const set = listeners.get(name);
    if (!set || set.size === 0) return;

    const normalized = normalizeHermesDisplayEventPayload(
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

module.exports = { LINK_DB_METHODS, LINK_DB_READ_TIMEOUT_MS, LINK_BACKEND_EVENT_METHOD, LINK_DISPATCH_METHOD, LINK_GW_METHODS, LINK_FOREIGN_METHODS, LINK_APPROVAL_RESOLVE_METHOD, LINK_CLARIFY_RESOLVE_METHOD, LINK_CLARIFY_AWAIT_TEXT_METHOD, LINK_SESSION_METHODS, LINK_PROFILE_METHODS, LINK_ATTACHMENT_INLINE_MAX_CHARS, DENIED_SESSION_SOURCES, alignUsageWindowLabel, normalizeBackendEventPayload, translateHermesSkillSlash, createHermesGatewayBridge, COMPACTION_SUMMARY_OPENERS, MERGED_SUMMARY_DELIMITER, classifyCompactionSummary };
