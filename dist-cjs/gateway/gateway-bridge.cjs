const { gatewaySessionKeyFor } = require("../runtime/openclaw-session-key.cjs");

function removeListenerCompat(emitter, eventName, listener) {
  if (typeof emitter.off === "function") {
    emitter.off(eventName, listener);
    return;
  }
  if (typeof emitter.removeListener === "function") {
    emitter.removeListener(eventName, listener);
  }
}

function defaultIdempotencyKey() {
  const globalCrypto = globalThis && globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    return globalCrypto.randomUUID();
  }
  return `ocuclaw-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function callClientMethod(openclawClient, name, args) {
  const fn = openclawClient && openclawClient[name];
  if (typeof fn !== "function") {
    throw new Error(`Gateway bridge requires a backend client with ${name}()`);
  }
  return fn.apply(openclawClient, args);
}

const SLASH_COMMAND_TEXT_RE = /^\/([A-Za-z][\w-]*)/;
const AGENT_INTERCEPTED_SLASH_COMMANDS = Object.freeze(["new", "reset"]);

function chatSendSlashCommandName(text) {
  if (typeof text !== "string") return "";
  const match = SLASH_COMMAND_TEXT_RE.exec(text);
  if (!match) return "";
  const name = match[1].toLowerCase();
  if (AGENT_INTERCEPTED_SLASH_COMMANDS.indexOf(name) !== -1) return "";
  return name;
}

function buildChatSendRequestParams(
  text,
  sessionKey,
  createIdempotencyKey,
  requestOptions = null,
) {
  const relaySessionKey = sessionKey || "main";
  const agentId =
    requestOptions && typeof requestOptions.agentId === "string"
      ? requestOptions.agentId.trim()
      : "";
  const gatewaySessionKey = gatewaySessionKeyFor(relaySessionKey, agentId);
  return {
    message: text,
    sessionKey: gatewaySessionKey,
    idempotencyKey: createIdempotencyKey(),
    ...(agentId && gatewaySessionKey !== relaySessionKey
      ? { agentId }
      : {}),
  };
}

function scopeOpenClawSessionKey(sessionKey, requestOptions) {
  const normalizedSessionKey =
    typeof sessionKey === "string" && sessionKey.trim()
      ? sessionKey.trim()
      : "main";
  const agentId =
    requestOptions && typeof requestOptions.agentId === "string"
      ? requestOptions.agentId.trim()
      : "";
  if (!agentId) return normalizedSessionKey;
  if (
    agentId.toLowerCase() === "main" &&
    !/^agent:[^:]+:/i.test(normalizedSessionKey)
  ) {
    return normalizedSessionKey;
  }
  const bareSessionKey = normalizedSessionKey.replace(/^agent:[^:]+:/i, "");
  return `agent:${agentId}:${bareSessionKey}`;
}

function callRequestMethod(openclawClient, method, params, requestOpts) {
  const requestFn = openclawClient && openclawClient.request;
  if (typeof requestFn !== "function") {
    throw new Error("Gateway bridge requires a backend client with request()");
  }
  return requestFn.call(openclawClient, method, params, requestOpts);
}

function buildAgentRequestParams(
  text,
  sessionKey,
  attachment,
  createIdempotencyKey,
  requestOptions,
  scopeOpenClawSessionKey = false,
) {
  const relaySessionKey = sessionKey || "main";
  const params = {
    message: text,
    sessionKey: relaySessionKey,
    idempotencyKey: createIdempotencyKey(),
  };
  const extraSystemPrompt =
    requestOptions && typeof requestOptions.extraSystemPrompt === "string"
      ? requestOptions.extraSystemPrompt.trim()
      : "";

  if (extraSystemPrompt) {
    params.extraSystemPrompt = extraSystemPrompt;
  }

  const thinking =
    requestOptions && typeof requestOptions.thinking === "string"
      ? requestOptions.thinking.trim().toLowerCase()
      : "";
  if (thinking) {
    params.thinking = thinking;
  }

  const agentId =
    requestOptions && typeof requestOptions.agentId === "string"
      ? requestOptions.agentId.trim()
      : "";
  if (agentId) {
    params.agentId = agentId;
    if (scopeOpenClawSessionKey) {
      params.sessionKey = gatewaySessionKeyFor(relaySessionKey, agentId);
    }
  }

  const deliverReply =
    requestOptions && typeof requestOptions.deliverReply === "string"
      ? requestOptions.deliverReply.trim().toLowerCase()
      : "";
  if (deliverReply) {
    if (deliverReply !== "local" && deliverReply !== "origin") {
      throw new Error("deliverReply must be 'local' or 'origin'");
    }
    params.deliverReply = deliverReply;
  }

  if (
    attachment &&
    typeof attachment === "object" &&
    typeof attachment.base64Data === "string" &&
    attachment.base64Data
  ) {
    const normalizedAttachment = {
      type: attachment.kind || "image",
      mimeType: attachment.mimeType || "image/jpeg",
      fileName: attachment.name || "image.jpg",
      content: attachment.base64Data,
    };
    if (typeof attachment.source === "string" && attachment.source) {
      normalizedAttachment.source = attachment.source;
    }
    if (Number.isFinite(attachment.sizeBytes) && attachment.sizeBytes > 0) {
      normalizedAttachment.sizeBytes = Math.floor(attachment.sizeBytes);
    }
    if (Number.isFinite(attachment.widthPx) && attachment.widthPx > 0) {
      normalizedAttachment.widthPx = Math.floor(attachment.widthPx);
    }
    if (Number.isFinite(attachment.heightPx) && attachment.heightPx > 0) {
      normalizedAttachment.heightPx = Math.floor(attachment.heightPx);
    }
    params.attachments = [
      normalizedAttachment,
    ];
  }

  return params;
}

function createPluginRpcGatewayBridge(opts) {
  const openclawClient = opts && opts.openclawClient;
  const idempotencyKeyFactory =
    opts && typeof opts.idempotencyKeyFactory === "function"
      ? opts.idempotencyKeyFactory
      : defaultIdempotencyKey;

  if (!openclawClient || typeof openclawClient !== "object") {
    throw new Error("Gateway bridge requires a backend client object");
  }
  if (typeof openclawClient.request !== "function") {
    throw new Error("Gateway bridge requires a backend client with request()");
  }

  function start() {
    if (typeof openclawClient.start === "function") {
      return openclawClient.start();
    }
  }

  function stop() {
    if (typeof openclawClient.stop === "function") {
      return openclawClient.stop();
    }
  }

  function request(method, params, requestOpts) {
    return callRequestMethod(openclawClient, method, params, requestOpts);
  }

  function sendMessage(text, sessionKey, attachment, requestOptions) {
    const requestOpts = { expectFinal: false };
    if (
      requestOptions &&
      typeof requestOptions.diagnostic === "object" &&
      requestOptions.diagnostic !== null
    ) {
      requestOpts.diagnostic = requestOptions.diagnostic;
    }

    const hasAttachment = Boolean(
      attachment &&
        typeof attachment === "object" &&
        typeof attachment.base64Data === "string" &&
        attachment.base64Data,
    );
    const gatewaySessionKey = scopeOpenClawSessionKey(sessionKey, requestOptions);
    if (!hasAttachment && chatSendSlashCommandName(text)) {
      return request(
        "chat.send",
        buildChatSendRequestParams(text, gatewaySessionKey, idempotencyKeyFactory),
        requestOpts,
      );
    }
    return request(
      "agent",
      buildAgentRequestParams(
        text,
        gatewaySessionKey,
        attachment,
        idempotencyKeyFactory,
        requestOptions,
        true,
      ),
      requestOpts,
    );
  }

  function resolveApproval(id, decision) {
    const method =
      typeof id === "string" && id.startsWith("plugin:")
        ? "plugin.approval.resolve"
        : "exec.approval.resolve";
    return request(method, { id, decision });
  }

  function off(eventName, listener) {
    removeListenerCompat(openclawClient, eventName, listener);
  }

  function subscribe(eventName, listener) {
    callClientMethod(openclawClient, "on", [eventName, listener]);
    return () => off(eventName, listener);
  }

  return {

    kind: "openclaw",
    start,
    stop,
    sendMessage,
    request,
    resolveApproval,
    on: subscribe,
    off,
    rawClient: openclawClient,
  };
}

module.exports = { createPluginRpcGatewayBridge, buildAgentRequestParams, buildChatSendRequestParams, gatewaySessionKeyFor };
