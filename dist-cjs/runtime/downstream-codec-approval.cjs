const { cleanPurposeLine } = require("../gateway/approval-context.cjs");
const { approvalBotScreenBody } = require("../tools/bot-screen/bot-screen-source.cjs");
const { APPROVAL_EXPLANATION_MAX } = require("./approval-explainer.cjs");
const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { deriveHermesPublicKey, isHermesSessionKey } = require("./hermes-session-keys.cjs");

const CODEX_APP_SERVER_APPROVAL_PLUGIN_ID = "openclaw-codex-app-server";
const CODEX_APP_SERVER_APPROVAL_TITLE_PREFIX = "Codex app-server ";
const CHAT_ESCAPE_ENTITIES = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", "\""],
  ["&#39;", "'"],
  ["&#x27;", "'"],
  ["&apos;", "'"],
]);
const CHAT_ESCAPE_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|#39|#x27);/g;

function isChatEscapedApprovalRequest(request     ) {
  if (!request || typeof request !== "object") return false;
  if (request.pluginId === CODEX_APP_SERVER_APPROVAL_PLUGIN_ID) return true;
  return (
    typeof request.title === "string" &&
    request.title.startsWith(CODEX_APP_SERVER_APPROVAL_TITLE_PREFIX)
  );
}

function decodeChatEscapedText(value     ) {
  if (typeof value !== "string" || value.indexOf("&") < 0) return value;
  return value.replace(CHAT_ESCAPE_ENTITY_RE, (entity) => CHAT_ESCAPE_ENTITIES.get(entity) ?? entity);
}

const CODEX_DESCRIPTION_LABEL_RE = /^([A-Z][A-Za-z]*(?: [a-z]+)*):\s?(.*)$/;
const CODEX_PREVIEW_OMITTED = "[preview truncated or unsafe content omitted]";

function codexAppServerApprovalCommand(request     ) {
  if (!isChatEscapedApprovalRequest(request) || typeof request.description !== "string") return null;
  const lines = decodeChatEscapedText(request.description).split(/\r?\n/);
  const commandLines           = [];
  let inCommand = false;
  let cwd = "";
  for (const line of lines) {
    const label = CODEX_DESCRIPTION_LABEL_RE.exec(line);
    if (label) {
      inCommand = label[1] === "Command";
      if (inCommand && commandLines.length === 0) commandLines.push(label[2]);
      else if (inCommand) inCommand = false;
      if (!cwd && (label[1] === "Cwd" || label[1] === "Working directory")) cwd = label[2].trim();
      continue;
    }
    if (inCommand) commandLines.push(line);
  }
  let command = commandLines.join("\n").trim();

  if (command.endsWith(CODEX_PREVIEW_OMITTED)) {
    command = command.slice(0, -CODEX_PREVIEW_OMITTED.length).trim();
    if (command && !/(\.\.\.|…)$/.test(command)) command = `${command} ...`;
  }
  return command ? { command, cwd } : null;
}

const APPROVAL_WARNING_LINES_MAX = 5;

function approvalWarningText(data     , request     ) {
  for (const source of [request, data]) {
    const value = source && typeof source.warningText === "string" ? source.warningText.trim() : "";
    if (value) return value;
  }
  return null;
}

function approvalWarningLines(data     , request     ) {
  const candidates = [
    request && request.commandAnalysis && request.commandAnalysis.warningLines,
    request && request.warningLines,
    data && data.commandAnalysis && data.commandAnalysis.warningLines,
    data && data.warningLines,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const lines = [];
    for (const entry of candidate) {
      if (typeof entry !== "string") continue;
      const line = entry.trim();
      if (line) lines.push(line);
      if (lines.length >= APPROVAL_WARNING_LINES_MAX) break;
    }
    if (lines.length > 0) return lines;
  }
  return [];
}

function approvalPurpose(data     ) {
  const context = data && data.ocuclawApprovalContext;
  const request = data && data.request;
  for (const value of [
    context && context.purpose,
    data && data.purpose,
    request && request.purpose,
  ]) {
    const line = cleanPurposeLine(value);
    if (line) return line;
  }
  return null;
}

function formatApprovalExplanation(data     ) {
  const id = data && typeof data.id === "string" ? data.id.trim() : "";
  const explanation = cleanPurposeLine(data && data.explanation, APPROVAL_EXPLANATION_MAX);
  if (!id || !explanation) return null;
  return JSON.stringify({
    type: APP_PROTOCOL.approvalExplanation,
    id,
    explanation,
  });
}

function formatApprovalExplanationPending(data     ) {
  const id = data && typeof data.id === "string" ? data.id.trim() : "";
  if (!id) return null;
  return JSON.stringify({
    type: APP_PROTOCOL.approvalExplanation,
    id,
    pending: data.pending === true,
  });
}

function formatApprovalResolved(data) {
  return JSON.stringify({
    type: APP_PROTOCOL.approvalResolved,
    id: data.id,
    requestId:
      data && typeof data.requestId === "string" && data.requestId
        ? data.requestId
        : null,
    decision: data.decision || null,
  });
}

function formatApprovalResponseAck(data) {
  return JSON.stringify({
    type: APP_PROTOCOL.approvalResolveAck,
    id: data && data.id ? data.id : null,
    decision: data && data.decision ? data.decision : null,
    requestId:
      data && data.requestId !== undefined && data.requestId !== null
        ? data.requestId
        : null,
    status:
      data && typeof data.status === "string" && data.status
        ? data.status
        : "rejected",
    code:
      data && typeof data.code === "string" && data.code
        ? data.code
        : null,
    message:
      data && typeof data.message === "string" && data.message
        ? data.message
        : null,
    idempotent:
      data && data.idempotent !== undefined
        ? !!data.idempotent
        : false,
  });
}

function createApprovalFormatter({ approvalPurposeEnabled }     ) {

  function formatApproval(data) {
    const request = data && data.request ? data.request : {};
    const approvalKind =
      (data && data.approvalKind === "plugin") ||
      (data && typeof data.id === "string" && data.id.startsWith("plugin:")) ||
      (typeof request.title === "string" && request.title.length > 0)
        ? "plugin"
        : "exec";
    const isPluginApproval = approvalKind === "plugin";
    const decodeText =
      isPluginApproval && isChatEscapedApprovalRequest(request)
        ? decodeChatEscapedText
        : (value     ) => value;
    const commandText = decodeText(
      request.command ||
      (request.host === "node" && request.systemRunPlan && typeof request.systemRunPlan.commandText === "string"
        ? request.systemRunPlan.commandText
        : "") ||
      (isPluginApproval && typeof request.title === "string" ? request.title : "") ||
      "",
    );
    const pluginDescription =
      isPluginApproval && typeof request.description === "string" && request.description.length > 0
        ? decodeText(request.description)
        : null;
    const warningText = approvalWarningText(data, request);
    const warningLines = approvalWarningLines(data, request);
    const purpose = approvalPurposeEnabled() ? approvalPurpose(data) : null;

    const botScreen = isPluginApproval ? null : approvalBotScreenBody(request.botScreen);
    return JSON.stringify({
      type: APP_PROTOCOL.approvalRequest,
      id: data.id,
      ...(isPluginApproval ? { approvalKind: "plugin" } : {}),
      requestId:
        (data && typeof data.requestId === "string" && data.requestId) ||
        (request && typeof request.requestId === "string" && request.requestId) ||
        null,
      command: commandText,
      cwd: request.cwd || pluginDescription || null,
      agentId: request.agentId || null,
      host: request.host || (isPluginApproval ? "plugin" : null),
      security: request.security || (isPluginApproval && typeof request.severity === "string" ? request.severity : null),
      ask: request.ask || null,
      resolvedPath: request.resolvedPath || null,
      sessionKey: request.sessionKey || null,
      ...(warningText ? { warningText } : {}),
      ...(warningLines.length > 0 ? { warningLines } : {}),
      ...(purpose ? { purpose } : {}),
      ...(botScreen ? { botScreen } : {}),
      ...(isPluginApproval
        ? {
            pluginId: typeof request.pluginId === "string" ? request.pluginId : null,
            toolName: typeof request.toolName === "string" ? request.toolName : null,
            description: pluginDescription,
          }
        : {}),
      createdAtMs: data.createdAtMs || 0,

      expiresAtMs:
        typeof data.expiresAtMs === "number" &&
        Number.isFinite(data.expiresAtMs) &&
        data.expiresAtMs > 0
          ? data.expiresAtMs
          : 0,
      allowedDecisions: Array.isArray(request.allowedDecisions)
        ? request.allowedDecisions.filter((d) => typeof d === "string")
        : null,
    });
  }

  return { formatApproval };
}

const WAITING_ITEMS_MAX = 16;
const WAITING_KINDS = new Set(["approval", "clarify", "sudo"]);
const WAITING_SURFACE_RE = /^[a-z0-9_-]{1,32}$/;
const WAITING_REQUEST_ID_MAX = 200;
const WAITING_TITLE_MAX = 200;
const WAITING_PREVIEW_MAX = 240;
const WAITING_CHOICES_MAX = 16;
const WAITING_CHOICE_MAX = 200;
const WAITING_OUTCOME_MAX = 64;
const WAITING_SESSION_KEY_MAX = 512;

function waitingTrimmedString(value     , max        ) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function waitingTimestamp(value     ) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function normalizeWaitingItem(raw     ) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const requestId = typeof raw.requestId === "string" ? raw.requestId.trim() : "";
  if (!requestId || requestId.length > WAITING_REQUEST_ID_MAX) return null;
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (!WAITING_KINDS.has(kind)) return null;
  const surface = typeof raw.surface === "string" ? raw.surface.trim().toLowerCase() : "";
  if (!WAITING_SURFACE_RE.test(surface)) return null;
  const sessionTitle = waitingTrimmedString(raw.sessionTitle, WAITING_TITLE_MAX);
  const item      = {
    requestId,
    kind,
    surface,
    sessionTitle: sessionTitle || null,
    preview: waitingTrimmedString(raw.preview, WAITING_PREVIEW_MAX),
    startedAtMs: waitingTimestamp(raw.startedAtMs),
    timeoutAtMs: waitingTimestamp(raw.timeoutAtMs),
    answerable: raw.answerable === true,
  };

  const derived = raw.session && typeof raw.session === "object" && !Array.isArray(raw.session)
    ? deriveHermesPublicKey(raw.session)
    : null;

  const sessionKey = derived ? derived.key : (isHermesSessionKey(raw.sessionKey) ? raw.sessionKey.trim() : "");
  if (typeof sessionKey === "string" && sessionKey && sessionKey.length <= WAITING_SESSION_KEY_MAX) {
    item.sessionKey = sessionKey;
  }
  if (Array.isArray(raw.choices)) {
    const choices = raw.choices
      .map((choice     ) => waitingTrimmedString(choice, WAITING_CHOICE_MAX))
      .filter((choice        ) => choice.length > 0)
      .slice(0, WAITING_CHOICES_MAX);
    if (choices.length > 0) {
      item.choices = choices;
      item.multiSelect = raw.multiSelect === true;
    }
  }

  if (kind === "clarify" && raw.botScreen === true) item.botScreen = true;

  if (kind === "approval" && raw.denyReason === false) item.denyReason = false;
  if (kind === "clarify" && item.choices && raw.allowOther === false) item.allowOther = false;

  if (kind === "approval" && raw.approvalKind === "plugin") item.approvalKind = "plugin";
  return item;
}

function normalizeWaitingPayload(payload     ) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.items)) {
    return null;
  }
  const items        = [];
  const seen = new Set();
  for (const raw of payload.items) {
    if (items.length >= WAITING_ITEMS_MAX) break;
    const item = normalizeWaitingItem(raw);
    if (!item || seen.has(item.requestId)) continue;
    seen.add(item.requestId);
    items.push(item);
  }
  const out      = { items };

  if (payload.host === "openclaw") out.host = "openclaw";
  const rawCleared = payload.cleared;
  if (rawCleared && typeof rawCleared === "object" && !Array.isArray(rawCleared)) {
    const requestId =
      typeof rawCleared.requestId === "string" ? rawCleared.requestId.trim() : "";
    if (requestId && requestId.length <= WAITING_REQUEST_ID_MAX) {
      const outcome = waitingTrimmedString(rawCleared.outcome, WAITING_OUTCOME_MAX);
      out.cleared = { requestId, outcome: outcome || null };
    }
  }
  return out;
}

function formatWaiting(payload     ) {
  const normalized = normalizeWaitingPayload(payload) || { items: [] };
  const frame      = { type: APP_PROTOCOL.waiting, items: normalized.items };
  if (normalized.host) frame.host = normalized.host;
  if (normalized.cleared) frame.cleared = normalized.cleared;
  return JSON.stringify(frame);
}

const WAITING_EXPLAIN_COMMAND_MAX = 2000;
const WAITING_EXPLAIN_DESCRIPTION_MAX = 500;
const WAITING_EXPLAIN_USER_MESSAGE_MAX = 600;
const WAITING_EXPLAIN_WARNING_LINES_MAX = 8;

function waitingExplainInput(raw     ) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  if (kind !== "approval") return null;
  const requestId = typeof raw.requestId === "string" ? raw.requestId.trim() : "";
  if (!requestId) return null;
  const explain = raw.explain;
  if (!explain || typeof explain !== "object" || Array.isArray(explain)) return null;
  const command = typeof explain.command === "string" ? explain.command.trim() : "";
  if (!command || command.length > WAITING_EXPLAIN_COMMAND_MAX) return null;
  const description = waitingTrimmedString(explain.description, WAITING_EXPLAIN_DESCRIPTION_MAX);
  const warningLines = description
    .split("; ")
    .map((line        ) => line.trim())
    .filter(Boolean)
    .slice(0, WAITING_EXPLAIN_WARNING_LINES_MAX);
  const userMessage = waitingTrimmedString(explain.userMessage, WAITING_EXPLAIN_USER_MESSAGE_MAX);
  return {
    requestId,
    command,
    warningLines,
    context: userMessage ? { userMessage } : null,
  };
}

function formatWaitingExplanation(payload     ) {
  const requestId =
    payload && typeof payload.requestId === "string" ? payload.requestId.trim() : "";
  if (!requestId || requestId.length > WAITING_REQUEST_ID_MAX) return null;
  const state = payload.state === "pending" || payload.state === "done" ? payload.state : "";
  if (!state) return null;
  const frame      = { type: APP_PROTOCOL.waitingExplanation, requestId, state };
  if (state === "done" && typeof payload.sentence === "string" && payload.sentence.trim()) {
    frame.sentence = payload.sentence.trim();
  }
  return JSON.stringify(frame);
}

module.exports = { WAITING_ITEMS_MAX, normalizeWaitingPayload, formatWaiting, waitingExplainInput, formatWaitingExplanation, codexAppServerApprovalCommand, formatApprovalExplanation, formatApprovalExplanationPending, formatApprovalResolved, formatApprovalResponseAck, createApprovalFormatter };
