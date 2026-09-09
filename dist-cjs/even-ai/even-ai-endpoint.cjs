const { createHash, createHmac, randomUUID } = require("node:crypto");
const { Agent } = require("undici");
const { constantTimeEqual } = require("../domain/constant-time-equal.cjs");
const { activeBackendDisplayName, getActiveBackendKind, isKnownBackendKind } = require("../gateway/backend-contract.cjs");
const { filterPlainAssistantOutputText } = require("../domain/message-emoji-filter.cjs");
const { composeReadabilitySystemPrompt } = require("../domain/readability-system-prompt.cjs");
const { normalizeEvenAiSystemPrompt } = require("./even-ai-settings-store.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");

const DEFAULT_RESPONSE_MODEL = "ocuclaw-active-session";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_BODY_BYTES = 65536;
const DEFAULT_DEDUP_WINDOW_MS = 500;

const DEFAULT_MAX_INTERCEPT_INFLIGHT = 4;
const EVEN_AI_MAX_PEER_FORWARD_DEPTH = 2;
const EVEN_AI_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const EVEN_AI_LISTEN_INJECT_FIELD = "ocuclawListenInject";
const EVEN_AI_PEER_FORWARD_FIELD = "ocuclawPeerForwarded";
const EVEN_AI_BINDING_AGENT_FIELD = "ocuclawBindingAgentRef";
const EVEN_AI_TARGET_SESSION_FIELD = "ocuclawTargetSession";
const EVEN_AI_PEER_FORWARD_DEPTH_FIELD = "ocuclawPeerForwardDepth";
const EVEN_AI_PEER_SIGNATURE_HEADER = "x-ocuclaw-peer-signature";
const EVEN_AI_PEER_SIGNATURE_PREFIX = "sha256=";
const REQUEST_HANDLED_MARKER = Symbol.for("ocuclaw.evenai.handled");
function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizePeerForwardDepth(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function trimString(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function hasPeerForwardControlMarker(payload) {
  if (!payload || typeof payload !== "object") return false;
  return (
    payload[EVEN_AI_LISTEN_INJECT_FIELD] === true ||
    payload[EVEN_AI_PEER_FORWARD_FIELD] === true ||
    payload[EVEN_AI_PEER_FORWARD_DEPTH_FIELD] !== undefined
  );
}

function normalizeDefaultModel(value) {
  return trimString(value);
}

function normalizeDefaultThinking(value) {
  const normalized = trimString(value).toLowerCase();
  if (
    ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(normalized)
  ) {
    return normalized;
  }
  return "";
}

function normalizeSessionKey(value) {
  const trimmed = trimString(value);
  return trimmed || null;
}

function parseBearerToken(headerValue) {
  const raw = trimString(headerValue);
  if (!raw) return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? trimString(match[1]) : "";
}

function classifyAuthFailure(configuredToken = "", authorizationToken = "") {
  if (!configuredToken) return "configured_token_missing";
  if (!authorizationToken) return "authorization_missing";
  return "token_mismatch";
}

function getHeaderValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const value = headers[name.toLowerCase()] || headers[name];
  if (Array.isArray(value)) return trimString(value[0]);
  return trimString(value);
}

function createPeerSignature(secret, bodyText) {
  const key = trimString(secret);
  if (!key) return "";
  return `${EVEN_AI_PEER_SIGNATURE_PREFIX}${createHmac("sha256", key)
    .update(typeof bodyText === "string" ? bodyText : "")
    .digest("hex")}`;
}

function normalizeBackendKind(value) {
  const normalized = trimString(value).toLowerCase();
  return isKnownBackendKind(normalized) ? normalized : "";
}

function inferBackendFromSessionKey(sessionKey, fallbackBackend) {
  const normalized = trimString(sessionKey).toLowerCase();
  if (normalized.startsWith("hermes:")) return "hermes";
  if (normalized.startsWith("ocuclaw:")) return "openclaw";
  if (normalized === "main") return normalizeBackendKind(fallbackBackend);
  return normalizeBackendKind(fallbackBackend);
}

function normalizePeerTarget(settingsSnapshot) {
  const peer =
    settingsSnapshot &&
    settingsSnapshot.evenAi &&
    typeof settingsSnapshot.evenAi === "object" &&
    settingsSnapshot.evenAi.peer &&
    typeof settingsSnapshot.evenAi.peer === "object"
      ? settingsSnapshot.evenAi.peer
      : null;
  return {
    url: trimString(peer && peer.url),
    bearerToken: trimString(peer && peer.bearerToken),
    forwardSecret: trimString(peer && peer.forwardSecret),
  };
}

function normalizeHeyEvenBinding(settingsSnapshot) {
  const binding =
    settingsSnapshot &&
    settingsSnapshot.pathways &&
    typeof settingsSnapshot.pathways === "object" &&
    settingsSnapshot.pathways.heyEven &&
    typeof settingsSnapshot.pathways.heyEven === "object" &&
    settingsSnapshot.pathways.heyEven.binding &&
    typeof settingsSnapshot.pathways.heyEven.binding === "object"
      ? settingsSnapshot.pathways.heyEven.binding
      : null;
  return {
    backend: normalizeBackendKind(binding && binding.backend),
    agentRef: trimString(binding && binding.agentRef),
  };
}

function peerTargetConfigured(peerTarget) {
  return !!(
    peerTarget &&
    peerTarget.url &&
    peerTarget.bearerToken &&
    peerTarget.forwardSecret
  );
}

function verifyPeerSignature({ headers, bodyText, settingsSnapshot }) {
  const peerTarget = normalizePeerTarget(settingsSnapshot || {});
  if (!peerTarget.forwardSecret) return false;
  const signature = getHeaderValue(headers, EVEN_AI_PEER_SIGNATURE_HEADER);
  if (!signature.startsWith(EVEN_AI_PEER_SIGNATURE_PREFIX)) return false;
  return constantTimeEqual(
    signature,
    createPeerSignature(peerTarget.forwardSecret, bodyText),
  );
}

function buildPeerEndpointUrl(rawUrl) {
  let url;
  try {
    url = new URL(trimString(rawUrl));
  } catch {
    throw new Error("Even AI peer pathway is not configured.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Even AI peer pathway must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Even AI peer pathway URL credentials are not allowed.");
  }
  if (!url.pathname || url.pathname === "/") {
    url.pathname = EVEN_AI_CHAT_COMPLETIONS_PATH;
  }
  return url;
}

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function mappedIpv4Address(address) {
  const normalized = String(address || "").toLowerCase();
  const prefix = normalized.startsWith("::ffff:")
    ? "::ffff:"
    : normalized.startsWith("::")
      ? "::"
      : "";
  if (!prefix) return "";
  const suffix = normalized.slice(prefix.length);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(suffix)) return suffix;
  const groups = suffix.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) {
    return "";
  }
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function ipAddressFamily(address) {
  const normalized = String(address || "").toLowerCase();
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return 4;
  if (/^[a-f0-9:.]+$/.test(normalized) && normalized.includes(":")) return 6;
  return 0;
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").toLowerCase();
  if (normalized === "::1") return true;
  const mapped = mappedIpv4Address(normalized);
  if (mapped) return isLoopbackAddress(mapped);
  if (ipAddressFamily(normalized) !== 4) return false;
  return Number(normalized.split(".")[0]) === 127;
}

function isPublicIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpAddress(address) {
  const normalized = String(address || "").toLowerCase();
  const family = ipAddressFamily(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family !== 6) return false;
  const mapped = mappedIpv4Address(normalized);
  if (mapped) return isPublicIpv4(mapped);
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[c-f]/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff")
  );
}

function isTailnetIpAddress(address) {
  const normalized = String(address || "").toLowerCase();
  if (ipAddressFamily(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return normalized.startsWith("fd7a:115c:a1e0:");
}

function peerAddressAllowed(hostname, address) {
  const normalizedHost = String(hostname || "").toLowerCase();
  return isPublicIpAddress(address) ||
    (normalizedHost === "localhost" && isLoopbackAddress(address)) ||
    (normalizedHost.endsWith(".ts.net") && isTailnetIpAddress(address));
}

function makePeerSafeLookup(resolveAddresses) {
  return function peerSafeLookup(hostname, options, callback) {
    Promise.resolve(resolveAddresses(hostname))
      .then((addresses) => {
        const records = Array.isArray(addresses)
          ? addresses.map((entry) => typeof entry === "string"
              ? { address: entry, family: ipAddressFamily(entry) }
              : entry,
            ).filter((entry) => entry && entry.address)
          : [];
        if (
          records.length === 0 ||
          records.some((entry) => !peerAddressAllowed(hostname, entry.address))
        ) {
          callback(new Error("Even AI peer pathway destination is not allowed."));
          return;
        }
        const family = options && (options.family === 4 || options.family === 6)
          ? options.family
          : 0;
        const matching = family
          ? records.filter((entry) => entry.family === family)
          : records;
        if (matching.length === 0) {
          callback(new Error("Even AI peer pathway destination could not be verified."));
          return;
        }
        if (options && options.all === true) {
          callback(null, matching);
          return;
        }
        callback(null, matching[0].address, matching[0].family);
      })
      .catch((error) => callback(error));
  };
}

async function assertAllowedPeerEndpointUrl(rawUrl, resolveAddresses) {
  const url = buildPeerEndpointUrl(rawUrl);
  const hostname = normalizedHostname(url);
  const loopback = hostname === "localhost" || isLoopbackAddress(hostname);
  if (url.protocol !== "https:" && !loopback) {
    throw new Error("Even AI peer pathway requires https outside loopback.");
  }
  if (loopback) return url.toString();

  if (ipAddressFamily(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new Error("Even AI peer pathway destination is not allowed.");
    }
    return url.toString();
  }
  if (!hostname.includes(".") || hostname.endsWith(".local")) {
    throw new Error("Even AI peer pathway destination is not allowed.");
  }

  let addresses;
  try {
    addresses = await resolveAddresses(hostname);
  } catch {
    throw new Error("Even AI peer pathway destination could not be verified.");
  }
  const normalizedAddresses = Array.isArray(addresses)
    ? addresses.map((entry) => typeof entry === "string" ? entry : entry && entry.address).filter(Boolean)
    : [];
  if (
    normalizedAddresses.length === 0 ||
    normalizedAddresses.some((address) => !peerAddressAllowed(hostname, address))
  ) {
    throw new Error("Even AI peer pathway destination is not allowed.");
  }
  return url.toString();
}

async function defaultResolvePeerAddresses(hostname) {

  const dns = await import("node:dns/promises");
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function buildCompletionPayload(opts = {}) {
  const createdMs =
    Number.isFinite(opts.createdMs) && opts.createdMs > 0
      ? Math.floor(opts.createdMs)
      : Date.now();
  return {
    id: trimString(opts.id) || `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(createdMs / 1000),
    model: trimString(opts.model) || DEFAULT_RESPONSE_MODEL,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: typeof opts.content === "string" ? opts.content : "",
        },
        finish_reason: "stop",
      },
    ],
  };
}

function buildListenInterceptCloseoutPayload(opts = {}) {
  return buildCompletionPayload({
    id: opts.id,
    createdMs: opts.createdMs,
    model: opts.model,
    content: "\u200B",
  });
}

function extractLastUserText(payload) {
  if (!payload || !Array.isArray(payload.messages)) {
    return null;
  }

  for (let idx = payload.messages.length - 1; idx >= 0; idx -= 1) {
    const message = payload.messages[idx];
    if (!message || message.role !== "user") continue;
    if (typeof message.content !== "string") {
      return null;
    }
    const text = trimString(message.content);
    return text ? message.content : null;
  }
  return null;
}

function parseHeyEvenAgentCommand(text = "") {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized) return null;
  const durable = /^set\s+default\s+to\s+(.+?)\s*[.!?,;:]*$/i.exec(normalized);
  if (durable && trimString(durable[1])) {
    return { kind: "default", name: trimString(durable[1]) };
  }
  const once = /^use\s+(.+?)\s*[.!?,;:]*$/i.exec(normalized);
  if (once && trimString(once[1])) {
    return { kind: "once", name: trimString(once[1]) };
  }
  return null;
}

function classifyHandledError(err) {
  const code = trimString(err && err.code).toLowerCase();
  const message = trimString(err && err.message).toLowerCase();

  if (code === "evenai_timeout") {
    return {
      event: "request_timeout",
      severity: "warn",
      content: "Even AI request timed out. Please try again.",
    };
  }

  if (
    code === "evenai_disconnected" ||
    message.includes("gateway not connected") ||
    message.includes("gateway disconnected") ||
    message.includes("gateway closed")
  ) {
    return {
      event: "request_disconnected",
      severity: "warn",
      content: `Even AI is unavailable because ${activeBackendDisplayName()} is disconnected.`,
    };
  }

  return {
    event: "request_failed",
    severity: "warn",
    content: "Even AI request failed upstream. Please try again.",
  };
}

function setJsonHeaders(res) {
  if (res.headersSent) return;
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
}

function writeJson(res, payload) {
  if (res.writableEnded) return;
  setJsonHeaders(res);
  res.end(JSON.stringify(payload));
}

function matchesEndpointRoute(req) {
  if (!req || typeof req.method !== "string") return false;
  if (req.method.toUpperCase() !== "POST") return false;
  const url = new URL(req.url || "/", "http://127.0.0.1");
  return url.pathname === EVEN_AI_CHAT_COMPLETIONS_PATH;
}

function readRequestBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;

    req.on("error", reject);
    req.on("aborted", () => {
      reject(new Error("request aborted"));
    });
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (truncated) {
        return;
      }
      if (totalBytes > maxBodyBytes) {
        truncated = true;
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      resolve({
        bodyText: Buffer.concat(chunks).toString("utf8"),
        bodyBytes: totalBytes,
        truncated,
      });
    });
  });
}

function createPeerResponseTooLargeError(maxBodyBytes) {
  const err = new Error("Even AI peer response exceeds the size limit.");
  err.code = "evenai_peer_response_too_large";
  err.maxBodyBytes = maxBodyBytes;
  return err;
}

async function readBoundedPeerResponseText(response, maxBodyBytes, onLimit) {
  if (!response) return "";
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buffer = Buffer.from(value || []);
        totalBytes += buffer.length;
        if (totalBytes > maxBodyBytes) {
          if (typeof onLimit === "function") {
            onLimit();
          }
          if (typeof reader.cancel === "function") {
            try {
              await reader.cancel("peer response too large");
            } catch (_) {}
          }
          throw createPeerResponseTooLargeError(maxBodyBytes);
        }
        chunks.push(buffer);
      }
    } finally {
      if (typeof reader.releaseLock === "function") {
        try {
          reader.releaseLock();
        } catch (_) {}
      }
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
      totalBytes += buffer.length;
      if (totalBytes > maxBodyBytes) {
        if (typeof onLimit === "function") {
          onLimit();
        }
        throw createPeerResponseTooLargeError(maxBodyBytes);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  if (typeof response.text !== "function") return "";
  const bodyText = await response.text();
  if (Buffer.byteLength(bodyText) > maxBodyBytes) {
    if (typeof onLimit === "function") {
      onLimit();
    }
    throw createPeerResponseTooLargeError(maxBodyBytes);
  }
  return bodyText;
}

function createEvenAiTimeoutError(timeoutMs) {
  const timeoutErr = new Error("Even AI request timed out.");
  timeoutErr.code = "evenai_timeout";
  timeoutErr.timeoutMs = timeoutMs;
  return timeoutErr;
}

function promiseWithTimeout(promise, timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(createEvenAiTimeoutError(timeoutMs));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const timeoutErr = createEvenAiTimeoutError(timeoutMs);
      if (typeof onTimeout === "function") {
        try {
          onTimeout(timeoutErr);
        } catch (_) {}
      }
      reject(timeoutErr);
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function createEvenAiEndpoint(opts = {}) {
  const logger = normalizeLogger(opts.logger);
  const httpServer = opts.httpServer || null;
  const enabled = opts.enabled === true;
  const externallyRouted = opts.externallyRouted === true;
  const token = trimString(opts.token);
  const getSystemPrompt =
    typeof opts.getSystemPrompt === "function"
      ? opts.getSystemPrompt
      : () => opts.systemPrompt;
  const hostProvidesReadability =
    Reflect.get(opts, "hostProvidesReadability") === true;
  const getSettingsSnapshot =
    typeof opts.getSettingsSnapshot === "function"
      ? opts.getSettingsSnapshot
      : () => opts.settingsSnapshot || {};
  const router = opts.router;
  const gatewayBridge = opts.gatewayBridge;
  const configuredDispatchGatewayUserSend = Reflect.get(
    opts,
    "dispatchGatewayUserSend",
  );
  const dispatchGatewayUserSend =
    typeof configuredDispatchGatewayUserSend === "function"
      ? configuredDispatchGatewayUserSend
      : (_sessionKey, send) => send();
  const configuredBeginPromptTurnOwnership = Reflect.get(
    opts,
    "beginPromptTurnOwnership",
  );
  const beginPromptTurnOwnership =
    typeof configuredBeginPromptTurnOwnership === "function"
      ? configuredBeginPromptTurnOwnership
      : () => null;
  const configuredCancelPromptTurnOwnership = Reflect.get(
    opts,
    "cancelPromptTurnOwnership",
  );
  const cancelPromptTurnOwnership =
    typeof configuredCancelPromptTurnOwnership === "function"
      ? configuredCancelPromptTurnOwnership
      : () => false;
  const configuredGatewayUserSendHoldDeadlineMs = Reflect.get(
    opts,
    "gatewayUserSendHoldDeadlineMs",
  );
  const runWaiter = opts.runWaiter;
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const onSessionActivated =
    typeof opts.onSessionActivated === "function" ? opts.onSessionActivated : null;
  const onSessionRouted =
    typeof opts.onSessionRouted === "function" ? opts.onSessionRouted : null;
  const recordFirstSentUserMessage =
    typeof opts.recordFirstSentUserMessage === "function"
      ? opts.recordFirstSentUserMessage
      : null;
  const dispatchOcuClawUserSend =
    typeof opts.dispatchOcuClawUserSend === "function"
      ? opts.dispatchOcuClawUserSend
      : null;
  const emitListenInterceptRecovery =
    typeof opts.emitListenInterceptRecovery === "function"
      ? opts.emitListenInterceptRecovery
      : null;
  const emitListenInterceptBroadcast =
    typeof opts.emitListenInterceptBroadcast === "function"
      ? opts.emitListenInterceptBroadcast
      : null;
  const isUpstreamConnected =
    typeof opts.isUpstreamConnected === "function"
      ? opts.isUpstreamConnected
      : () => false;
  const hasConnectedAppClient =
    typeof opts.hasConnectedAppClient === "function"
      ? opts.hasConnectedAppClient
      : () => false;
  const shouldSeedThinkingForRoute =
    typeof opts.shouldSeedThinkingForRoute === "function"
      ? opts.shouldSeedThinkingForRoute
      : async () => false;
  const seedFastModeForRoute =
    typeof opts.seedFastModeForRoute === "function"
      ? opts.seedFastModeForRoute
      : null;
  const configuredSeedDefaultModelForRoute = Reflect.get(
    opts,
    "seedDefaultModelForRoute",
  );
  const seedDefaultModelForRoute =
    typeof configuredSeedDefaultModelForRoute === "function"
      ? configuredSeedDefaultModelForRoute
      : null;
  const resolveAgentForRoute =
    typeof opts.resolveAgentForRoute === "function"
      ? opts.resolveAgentForRoute
      : null;
  const configuredGetAgentsCatalogSnapshot = Reflect.get(
    opts,
    "getAgentsCatalogSnapshot",
  );
  const getAgentsCatalogSnapshot =
    typeof configuredGetAgentsCatalogSnapshot === "function"
      ? configuredGetAgentsCatalogSnapshot
      : null;
  const configuredSetHeyEvenBinding = Reflect.get(opts, "setHeyEvenBinding");
  const setHeyEvenBinding =
    typeof configuredSetHeyEvenBinding === "function"
      ? configuredSetHeyEvenBinding
      : null;
  const fetchImpl =
    typeof opts.fetch === "function"
      ? opts.fetch
      : typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null;
  const configuredResolvePeerAddresses = Reflect.get(opts, "resolvePeerAddresses");
  const resolvePeerAddresses =
    typeof configuredResolvePeerAddresses === "function"
      ? configuredResolvePeerAddresses
      : defaultResolvePeerAddresses;
  const configuredPeerDispatcher = Reflect.get(opts, "peerDispatcher");
  const peerDispatcher = configuredPeerDispatcher === null
    ? null
    : configuredPeerDispatcher || new Agent({
        connect: { lookup: makePeerSafeLookup(resolvePeerAddresses) },
      });
  const ownsPeerDispatcher = !configuredPeerDispatcher && peerDispatcher;
  const localBackendKind =
    normalizeBackendKind(opts.localBackendKind) ||
    normalizeBackendKind(gatewayBridge && gatewayBridge.kind) ||
    normalizeBackendKind(getActiveBackendKind()) ||
    "openclaw";
  const now =
    typeof opts.now === "function" ? opts.now : () => Date.now();
  const requestTimeoutMs = normalizePositiveInt(
    opts.requestTimeoutMs,
    DEFAULT_TIMEOUT_MS,
  );
  const gatewayUserSendHoldDeadlineMs =
    Number.isFinite(configuredGatewayUserSendHoldDeadlineMs) &&
    configuredGatewayUserSendHoldDeadlineMs > 0
      ? Math.floor(configuredGatewayUserSendHoldDeadlineMs)
      : 0;
  const gatewayUserSendHoldMarginMs = Math.max(
    1,
    Math.min(1_000, Math.ceil(gatewayUserSendHoldDeadlineMs / 10)),
  );
  const gatewayUserSendTimeoutMs =
    gatewayUserSendHoldDeadlineMs > 0
      ? Math.max(
          requestTimeoutMs,
          gatewayUserSendHoldDeadlineMs + gatewayUserSendHoldMarginMs,
        )
      : requestTimeoutMs;
  const maxBodyBytes = normalizePositiveInt(
    opts.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
  );
  const dedupWindowMs = Math.max(
    0,
    normalizePositiveInt(opts.dedupWindowMs, DEFAULT_DEDUP_WINDOW_MS),
  );
  const maxInterceptInflight = normalizePositiveInt(
    opts.maxInterceptInflight,
    DEFAULT_MAX_INTERCEPT_INFLIGHT,
  );
  const maxPeerForwardInflight = normalizePositiveInt(
    opts.maxPeerForwardInflight,
    maxInterceptInflight,
  );

  if (!gatewayBridge || typeof gatewayBridge.sendMessage !== "function") {
    throw new Error("Even AI endpoint requires gatewayBridge.sendMessage()");
  }
  if (
    !router ||
    (
      typeof router.resolveTargetSession !== "function" &&
      typeof router.resolveActiveSession !== "function"
    )
  ) {
    throw new Error(
      "Even AI endpoint requires router.resolveTargetSession() or router.resolveActiveSession()",
    );
  }
  if (!runWaiter || typeof runWaiter.waitForRun !== "function") {
    throw new Error("Even AI endpoint requires runWaiter.waitForRun()");
  }

  let inFlight = null;
  const inFlightFinalContent = new Map();

  let interceptInflight = 0;
  let peerForwardInflight = 0;

  let heyEvenOneShotAgentRef = "";
  let heyEvenOneShotGeneration = 0;

  let lastAccepted = null;

  async function resolveCommandAgent(
    name = "",
    settingsSnapshot = {
      pathways: {
        heyEven: {
          binding: { backend: "", agentRef: "" },
        },
      },
    },
  ) {
    const binding = normalizeHeyEvenBinding(settingsSnapshot);
    const boundBackend = binding.backend || localBackendKind;
    if (boundBackend !== localBackendKind || !getAgentsCatalogSnapshot) {
      return { status: "unavailable" };
    }
    let snapshot;
    try {
      snapshot = await Promise.resolve(getAgentsCatalogSnapshot());
    } catch {
      return { status: "unavailable" };
    }
    if (
      !snapshot ||
      snapshot.unsupported === true ||
      snapshot.stale === true ||
      !Array.isArray(snapshot.agents)
    ) {
      return { status: "unavailable" };
    }
    const needle = trimString(name).toLowerCase();
    const match = snapshot.agents.find(
      (entry = { id: "", name: "", display: "" }) => {
      if (!entry || typeof entry !== "object") return false;
      return [entry.id, entry.name, entry.display].some(
        (value) => trimString(value).toLowerCase() === needle,
      );
      },
    );
    if (!match) return { status: "not_found" };
    const agentRef = trimString(match.id) || trimString(match.name);
    if (!agentRef) return { status: "not_found" };
    return {
      status: "resolved",
      agentRef,
      display: trimString(match.display) || trimString(match.name) || agentRef,
      backend: boundBackend,
    };
  }

  async function forwardToPeerEndpoint({
    peerTarget,
    payload,
    injectListen,
    binding,
    sessionKey,
    forwardDepth,
    requestId,
    startedAtMs,
    responseModel,
    abortController,
    res,
  }) {
    if (!fetchImpl) {
      throw new Error("Even AI peer pathway fetch is unavailable.");
    }
    if (!peerTargetConfigured(peerTarget)) {
      throw new Error("Even AI peer pathway is not configured.");
    }
    const peerUrl = await assertAllowedPeerEndpointUrl(
      peerTarget.url,
      resolvePeerAddresses,
    );
    const forwardedPayload = {
      ...(payload && typeof payload === "object" ? payload : {}),
    };
    forwardedPayload[EVEN_AI_PEER_FORWARD_DEPTH_FIELD] = normalizePeerForwardDepth(
      forwardDepth,
    ) || 1;
    const bindingAgentRef = trimString(binding && binding.agentRef);
    if (injectListen) {
      forwardedPayload[EVEN_AI_LISTEN_INJECT_FIELD] = true;
      delete forwardedPayload[EVEN_AI_PEER_FORWARD_FIELD];
      delete forwardedPayload[EVEN_AI_BINDING_AGENT_FIELD];
      const targetSessionKey = normalizeSessionKey(sessionKey);
      if (targetSessionKey) {
        forwardedPayload[EVEN_AI_TARGET_SESSION_FIELD] = targetSessionKey;
      } else {
        delete forwardedPayload[EVEN_AI_TARGET_SESSION_FIELD];
      }
    } else {
      delete forwardedPayload[EVEN_AI_LISTEN_INJECT_FIELD];
      delete forwardedPayload[EVEN_AI_TARGET_SESSION_FIELD];
      forwardedPayload[EVEN_AI_PEER_FORWARD_FIELD] = true;
      if (bindingAgentRef) {
        forwardedPayload[EVEN_AI_BINDING_AGENT_FIELD] = bindingAgentRef;
      } else {
        delete forwardedPayload[EVEN_AI_BINDING_AGENT_FIELD];
      }
    }
    const forwardedBodyText = JSON.stringify(forwardedPayload);

    emitDebug(
      "evenai",
      "peer_forward_started",
      "info",
      null,
      () => ({
        requestId,
        peerUrl,
        injectListen: !!injectListen,
      }),
    );

    const fetchAbortController =
      abortController && typeof abortController.abort === "function"
        ? abortController
        : typeof AbortController === "function"
          ? new AbortController()
          : null;
    const abortPeerFetch = () => {
      if (fetchAbortController) {
        fetchAbortController.abort();
      }
    };
    const { status, bodyText } = await promiseWithTimeout(
      (async () => {
        const response = await fetchImpl(peerUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${peerTarget.bearerToken}`,
            [EVEN_AI_PEER_SIGNATURE_HEADER]: createPeerSignature(
              peerTarget.forwardSecret,
              forwardedBodyText,
            ),
          },
          body: forwardedBodyText,
          ...(peerDispatcher ? { dispatcher: peerDispatcher } : {}),
          redirect: "error",
          signal: fetchAbortController ? fetchAbortController.signal : undefined,
        });
        const status = Number.isFinite(response && response.status)
          ? Math.floor(response.status)
          : 0;
        if (status < 200 || status >= 300) {
          abortPeerFetch();
          return { status, bodyText: "" };
        }
        return {
          status,
          bodyText: await readBoundedPeerResponseText(
            response,
            maxBodyBytes,
            abortPeerFetch,
          ),
        };
      })(),
      requestTimeoutMs,
      abortPeerFetch,
    );
    if (status < 200 || status >= 300) {
      throw new Error(`Even AI peer pathway returned HTTP ${status || "unknown"}.`);
    }
    let responsePayload;
    try {
      responsePayload = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      throw new Error("Even AI peer pathway returned invalid JSON.");
    }
    emitDebug(
      "evenai",
      "peer_forward_completed",
      "info",
      null,
      () => ({
        requestId,
        elapsedMs: now() - startedAtMs,
        injectListen: !!injectListen,
      }),
    );
    writeJson(
      res,
      responsePayload || buildCompletionPayload({
        id: requestId,
        createdMs: startedAtMs,
        model: responseModel,
        content: "",
      }),
    );
  }

  async function resolveRoutingDecision({
    payload,
    settingsSnapshot,
    listenEnabled,
    upstreamConnected,
    trustedPeerForward,
    requestId,
    responseModel,
    userText,
  }) {
    const peerTarget = normalizePeerTarget(settingsSnapshot);
    const peerConfigured = peerTargetConfigured(peerTarget);
    const explicitPeerInject =
      !!(trustedPeerForward && payload && payload[EVEN_AI_LISTEN_INJECT_FIELD] === true);
    const explicitPeerForward =
      !!(trustedPeerForward && payload && payload[EVEN_AI_PEER_FORWARD_FIELD] === true);
    const listenInjectRequested =
      explicitPeerInject || (listenEnabled && !explicitPeerForward);
    const connectedAppClient = hasConnectedAppClient();
    const inboundPeerForwardDepth = normalizePeerForwardDepth(
      payload && payload[EVEN_AI_PEER_FORWARD_DEPTH_FIELD],
    );
    const untrustedPeerControlMarker =
      !trustedPeerForward && hasPeerForwardControlMarker(payload);
    const signedTargetSessionKey = explicitPeerInject
      ? normalizeSessionKey(payload && payload[EVEN_AI_TARGET_SESSION_FIELD])
      : null;

    if (
      listenInjectRequested &&
      (signedTargetSessionKey || typeof router.resolveActiveSession === "function")
    ) {
      const sessionKey =
        signedTargetSessionKey ||
        normalizeSessionKey(
          router.resolveActiveSession({
            requestId,
            model: responseModel,
            userText,
          }),
        ) || "main";
      const activeBackend = inferBackendFromSessionKey(sessionKey, localBackendKind);
      if (
        listenEnabled &&
        !explicitPeerInject &&
        activeBackend &&
        activeBackend !== localBackendKind
      ) {
        if (!peerConfigured) {
          return {
            kind: "pathway-error",
            content: "Even AI peer pathway is not configured.",
          };
        }
        if (untrustedPeerControlMarker) {
          return {
            kind: "pathway-error",
            content: "Even AI peer pathway signature could not be verified.",
          };
        }
        if (inboundPeerForwardDepth >= EVEN_AI_MAX_PEER_FORWARD_DEPTH) {
          return {
            kind: "pathway-error",
            content: "Even AI peer pathway exceeded the forward limit.",
          };
        }
        return {
          kind: "peer-forward",
          peerTarget,
          injectListen: true,
          sessionKey,
          forwardDepth: inboundPeerForwardDepth + 1,
        };
      }
      if (
        activeBackend === localBackendKind &&
        upstreamConnected &&
        connectedAppClient &&
        dispatchOcuClawUserSend
      ) {
        return {
          kind: "listen-intercept",
          sessionKey,
        };
      }
    }

    if (explicitPeerInject) {
      return {
        kind: "pathway-error",
        content: "Even AI listen target is unavailable.",
      };
    }

    if (!listenEnabled && !explicitPeerForward) {
      const binding = normalizeHeyEvenBinding(settingsSnapshot);
      if (
        binding.backend &&
        binding.backend !== localBackendKind
      ) {
        if (untrustedPeerControlMarker) {
          return {
            kind: "pathway-error",
            content: "Even AI peer pathway signature could not be verified.",
          };
        }
        if (inboundPeerForwardDepth >= EVEN_AI_MAX_PEER_FORWARD_DEPTH) {
          return {
            kind: "pathway-error",
            content: "Even AI peer pathway exceeded the forward limit.",
          };
        }
        return {
          kind: "peer-forward",
          peerTarget,
          injectListen: false,
          binding,
          forwardDepth: inboundPeerForwardDepth + 1,
        };
      }
      if (binding.backend === localBackendKind && binding.agentRef) {
        return {
          kind: "local-direct",
          binding,
        };
      }
    }

    return {
      kind: "local-direct",
      binding: {
        backend: "",
        agentRef: explicitPeerForward
          ? trimString(payload && payload[EVEN_AI_BINDING_AGENT_FIELD])
          : "",
      },
    };
  }

  async function resolveLocalTargetRoute({
    requestId = "",
    responseModel = "",
    userText = "",
    agentRef = "",
  } = {}) {
    return (
      typeof router.resolveTargetSession === "function"
        ? await router.resolveTargetSession({
            requestId,
            model: responseModel,
            userText,
            agentRef,
          })
        : {
            routingMode: "active",
            sessionKey: router.resolveActiveSession(),
            previousSessionKey: null,
            sessionChanged: false,
          }
    );
  }

  async function handleRequest(req, res) {
    if (!enabled) return false;
    if (!matchesEndpointRoute(req)) return false;
    if (res.writableEnded) return true;

    req[REQUEST_HANDLED_MARKER] = true;
    res[REQUEST_HANDLED_MARKER] = true;

    const requestId = `chatcmpl-${randomUUID()}`;
    const startedAtMs = now();
    const authToken = parseBearerToken(req.headers && req.headers.authorization);
    const configuredSystemPrompt = normalizeEvenAiSystemPrompt(getSystemPrompt());
    const systemPrompt = composeReadabilitySystemPrompt(configuredSystemPrompt, {
      hostProvidesReadability,
    });

    emitDebug(
      "evenai",
      "request_received",
      "info",
      null,
      () => ({
        requestId,
        method: req.method || null,
        bodyLimitBytes: maxBodyBytes,
        hasAuthorization: !!authToken,
        userAgentTail:
          req.headers && typeof req.headers["user-agent"] === "string"
            ? req.headers["user-agent"].slice(-120)
            : null,
      }),
    );

    if (!token || !constantTimeEqual(authToken, token)) {
      emitDebug(
        "evenai",
        "request_auth_failed",
        "warn",
        null,
        () => ({
          requestId,
          hasConfiguredToken: !!token,
          hasAuthorization: !!authToken,
          failureReason: classifyAuthFailure(token, authToken),
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          content: "Authentication failed.",
        }),
      );
      return true;
    }

    let bodyResult;
    try {
      bodyResult = await readRequestBody(req, maxBodyBytes);
    } catch (err) {
      emitDebug(
        "evenai",
        "request_body_read_failed",
        "warn",
        null,
        () => ({
          requestId,
          message: err && err.message ? err.message : String(err),
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          content: "Request body could not be read.",
        }),
      );
      return true;
    }

    if (bodyResult.truncated) {
      emitDebug(
        "evenai",
        "request_body_too_large",
        "warn",
        null,
        () => ({
          requestId,
          bodyBytes: bodyResult.bodyBytes,
          maxBodyBytes,
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          content: "Request body exceeds the Even AI size limit.",
        }),
      );
      return true;
    }

    let payload;
    try {
      payload = JSON.parse(bodyResult.bodyText);
    } catch (err) {
      emitDebug(
        "evenai",
        "request_invalid_json",
        "warn",
        null,
        () => ({
          requestId,
          bodyBytes: bodyResult.bodyBytes,
          message: err && err.message ? err.message : String(err),
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          content: "Request body must be valid JSON.",
        }),
      );
      return true;
    }

    const settingsSnapshot = getSettingsSnapshot() || {};
    const trustedPeerForward = verifyPeerSignature({
      headers: req.headers,
      bodyText: bodyResult.bodyText,
      settingsSnapshot,
    });
    const configuredDefaultModel = normalizeDefaultModel(settingsSnapshot.defaultModel);
    const configuredDefaultThinking = normalizeDefaultThinking(
      settingsSnapshot.defaultThinking,
    );
    const listenEnabled = settingsSnapshot.listenEnabled === true;
    const responseModel =
      trimString(payload && payload.model) ||
      configuredDefaultModel ||
      DEFAULT_RESPONSE_MODEL;
    const userText = extractLastUserText(payload);
    if (!userText) {
      emitDebug(
        "evenai",
        "request_invalid_messages",
        "warn",
        null,
        () => ({
          requestId,
          bodyBytes: bodyResult.bodyBytes,
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
          content: "The last user message must be plain text.",
        }),
      );
      return true;
    }

    const agentCommand = parseHeyEvenAgentCommand(userText);
    if (agentCommand) {
      const agentResolution = await resolveCommandAgent(
        agentCommand.name,
        settingsSnapshot,
      );
      if (
        agentCommand.kind === "once" &&
        agentResolution.status === "resolved"
      ) {
        heyEvenOneShotAgentRef = agentResolution.agentRef;
        heyEvenOneShotGeneration += 1;
        writeJson(
          res,
          buildCompletionPayload({
            id: requestId,
            createdMs: startedAtMs,
            model: responseModel,
            content: `Using ${agentResolution.display} for the next session.`,
          }),
        );
        return true;
      }
      if (agentCommand.kind === "default") {
        let content;
        if (agentResolution.status === "unavailable") {
          content = "Agent switching is unavailable right now.";
        } else if (agentResolution.status === "not_found") {
          content = `No agent named ${agentCommand.name}.`;
        } else if (!setHeyEvenBinding) {
          content = "Agent switching is unavailable right now.";
        } else {
          const currentBinding = normalizeHeyEvenBinding(settingsSnapshot);
          const backend = currentBinding.backend || localBackendKind;
          const bindingGeneration = heyEvenOneShotGeneration;
          const bindingResult = await Promise.resolve(
            setHeyEvenBinding({
              backend,
              agentRef: agentResolution.agentRef,
            }),
          );
          if (
            bindingResult &&
            typeof bindingResult === "object" &&
            bindingResult.status === "accepted"
          ) {
            if (heyEvenOneShotGeneration === bindingGeneration) {
              heyEvenOneShotAgentRef = "";
              heyEvenOneShotGeneration += 1;
            }
            content = `Default set to ${agentResolution.display}.`;
          } else {
            content = "Couldn't save the default agent.";
          }
        }
        writeJson(
          res,
          buildCompletionPayload({
            id: requestId,
            createdMs: startedAtMs,
            model: responseModel,
            content,
          }),
        );
        return true;
      }
    }

    const upstreamConnected = isUpstreamConnected();
    let routeDecision;
    try {
      routeDecision = await resolveRoutingDecision({
        payload,
        settingsSnapshot,
        listenEnabled,
        upstreamConnected,
        trustedPeerForward,
        requestId,
        responseModel,
        userText,
      });
    } catch (err) {
      emitDebug(
        "evenai",
        "request_routing_failed",
        "warn",
        null,
        () => ({
          requestId,
          message: err && err.message ? err.message : String(err),
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
          content: "Even AI request failed upstream. Please try again.",
        }),
      );
      return true;
    }
    const interceptListenRequest =
      routeDecision && routeDecision.kind === "listen-intercept";
    const peerForwardRequest =
      routeDecision && routeDecision.kind === "peer-forward";
    const fingerprint = createHash("sha1")
      .update(bodyResult.bodyText || "")
      .digest("hex");
    if (
      lastAccepted &&
      lastAccepted.fingerprint === fingerprint &&
      startedAtMs - lastAccepted.startedAtMs <= dedupWindowMs
    ) {
      if (
        interceptListenRequest ||
        (peerForwardRequest && routeDecision.injectListen === true)
      ) {
        emitDebug(
          "evenai",
          "request_deduplicated",
          "info",
          null,
          () => ({
            requestId,
            dedupWindowMs,
            mode: "closeout",
            elapsedMs: now() - startedAtMs,
          }),
        );
        writeJson(
          res,
          buildListenInterceptCloseoutPayload({
            id: requestId,
            createdMs: startedAtMs,
            model: responseModel,
          }),
        );
      } else {
        const matchingFinalContent =
          inFlightFinalContent.get(fingerprint) || null;
        const duplicateRouteKind =
          trimString(routeDecision && routeDecision.kind) || "local-direct";
        const duplicateBindingAgentRef = trimString(
          routeDecision &&
            routeDecision.binding &&
            routeDecision.binding.agentRef,
        );
        const duplicateBindingBackend =
          trimString(
            routeDecision &&
              routeDecision.binding &&
              routeDecision.binding.backend,
          ) || localBackendKind;
        const routingIdentityMatches =
          matchingFinalContent &&
          matchingFinalContent.kind === duplicateRouteKind &&
          matchingFinalContent.bindingAgentRef === duplicateBindingAgentRef &&
          matchingFinalContent.bindingBackend === duplicateBindingBackend;
        let joinedContent = null;
        let duplicateDisconnected = false;
        if (routingIdentityMatches) {

          const remainingTimeoutMs =
            requestTimeoutMs - (now() - startedAtMs);
          const content = await new Promise((resolve) => {
            let settled = false;
            const onDuplicateClose = () => {
              if (!res.writableEnded) duplicateDisconnected = true;
              finish(null);
            };
            const finish = (value) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (typeof res.removeListener === "function") {
                res.removeListener("close", onDuplicateClose);
              }
              resolve(value);
            };
            const timer = setTimeout(() => finish(null), Math.max(1, remainingTimeoutMs));
            res.once("close", onDuplicateClose);
            matchingFinalContent.promise.then(
              (value) => finish(typeof value === "string" ? value : null),
              () => finish(null),
            );
          });
          if (
            !duplicateDisconnected &&
            typeof content === "string" &&
            content.length > 0
          ) {
            joinedContent = content;
          }
        }
        const mode = joinedContent === null ? "closeout" : "joined";
        emitDebug(
          "evenai",
          "request_deduplicated",
          "info",
          null,
          () => ({
            requestId,
            dedupWindowMs,
            mode,
            elapsedMs: now() - startedAtMs,
          }),
        );
        if (joinedContent === null) {
          writeJson(
            res,
            buildListenInterceptCloseoutPayload({
              id: requestId,
              createdMs: startedAtMs,
              model: responseModel,
            }),
          );
        } else {
          writeJson(
            res,
            buildCompletionPayload({
              id: requestId,
              createdMs: startedAtMs,
              model: responseModel,
              content: joinedContent,
            }),
          );
        }
      }
      return true;
    }

    if (routeDecision && routeDecision.kind === "pathway-error") {
      emitDebug(
        "evenai",
        "pathway_unavailable",
        "warn",
        null,
        () => ({
          requestId,
          reason: routeDecision.content,
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
          content: routeDecision.content,
        }),
      );
      return true;
    }

    if (peerForwardRequest) {
      if (peerForwardInflight >= maxPeerForwardInflight) {
        emitDebug(
          "evenai",
          "peer_forward_capacity_exceeded",
          "warn",
          null,
          () => ({
            requestId,
            peerForwardInflight,
            maxPeerForwardInflight,
          }),
        );
        if (routeDecision.injectListen === true) {
          writeJson(
            res,
            buildListenInterceptCloseoutPayload({
              id: requestId,
              createdMs: startedAtMs,
              model: responseModel,
            }),
          );
        } else {
          writeJson(
            res,
            buildCompletionPayload({
              id: requestId,
              createdMs: startedAtMs,
              model: responseModel,
              content: "Even AI peer pathway is busy. Please retry shortly.",
            }),
          );
        }
        return true;
      }
      peerForwardInflight += 1;
      lastAccepted = {
        fingerprint,
        startedAtMs,
      };
      const peerAbortController =
        typeof AbortController === "function" ? new AbortController() : null;
      let peerClientDisconnected = false;
      const onPeerClientDisconnect = () => {
        if (res.writableEnded) return;
        peerClientDisconnected = true;
        if (peerAbortController) {
          peerAbortController.abort();
        }
      };
      if (typeof res.once === "function") {
        res.once("close", onPeerClientDisconnect);
      }
      try {
        await forwardToPeerEndpoint({
          peerTarget: routeDecision.peerTarget,
          payload,
          injectListen: routeDecision.injectListen === true,
          binding: routeDecision.binding,
          sessionKey: routeDecision.sessionKey,
          forwardDepth: routeDecision.forwardDepth,
          requestId,
          startedAtMs,
          responseModel,
          abortController: peerAbortController,
          res,
        });
      } catch (err) {
        if (
          lastAccepted &&
          lastAccepted.fingerprint === fingerprint &&
          lastAccepted.startedAtMs === startedAtMs
        ) {
          lastAccepted = null;
        }
        if (peerClientDisconnected) {
          emitDebug(
            "evenai",
            "peer_forward_client_disconnect",
            "info",
            null,
            () => ({
              requestId,
              elapsedMs: now() - startedAtMs,
            }),
          );
          return true;
        }
        emitDebug(
          "evenai",
          "peer_forward_failed",
          "warn",
          null,
          () => ({
            requestId,
            elapsedMs: now() - startedAtMs,
            message: err && err.message ? err.message : String(err),
          }),
        );
        writeJson(
          res,
          buildCompletionPayload({
            id: requestId,
            createdMs: startedAtMs,
            model: responseModel,
            content:
              err && err.message && err.message.includes("not configured")
                ? "Even AI peer pathway is not configured."
                : "Even AI peer pathway failed. Please try again.",
          }),
        );
      } finally {
        if (typeof res.removeListener === "function") {
          res.removeListener("close", onPeerClientDisconnect);
        }
        peerForwardInflight -= 1;
      }
      return true;
    }

    if (!interceptListenRequest && inFlight) {
      emitDebug(
        "evenai",
        "request_busy",
        "info",
        {
          sessionKey: inFlight.sessionKey || undefined,
        },
        () => ({
          requestId,
          activeRequestId: inFlight.requestId,
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
          content: "Even AI is busy with another request. Please retry shortly.",
        }),
      );
      return true;
    }

    if (!interceptListenRequest && !upstreamConnected) {
      emitDebug(
        "evenai",
        "request_disconnected",
        "warn",
        null,
        () => ({
          requestId,
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
          content: `Even AI is unavailable because ${activeBackendDisplayName()} is disconnected.`,
        }),
      );
      return true;
    }

    if (interceptListenRequest) {
      const sessionKey =
        normalizeSessionKey(routeDecision && routeDecision.sessionKey) || "main";

      if (interceptInflight >= maxInterceptInflight) {
        emitDebug(
          "evenai",
          "listen_intercept_capacity_exceeded",
          "warn",
          { sessionKey },
          () => ({
            requestId,
            interceptInflight,
            maxInterceptInflight,
          }),
        );
        writeJson(
          res,
          buildListenInterceptCloseoutPayload({
            id: requestId,
            createdMs: startedAtMs,
            model: responseModel,
          }),
        );
        return true;
      }
      lastAccepted = {
        fingerprint,
        startedAtMs,
      };

      emitDebug(
        "evenai",
        "listen_intercepted",
        "info",
        { sessionKey },
        () => ({
          requestId,
          bodyBytes: bodyResult.bodyBytes,
          messageChars: userText.length,
          model: responseModel,
          listenEnabled,
        }),
      );

      interceptInflight += 1;
      void (async () => {
        try {
          const dispatchResult = await Promise.resolve(
            dispatchOcuClawUserSend({
              id: requestId,
              text: userText,
              sessionKey,
              source: "hybrid_voice_endpoint",
            }),
          );
          const dispatchRunId =
            dispatchResult &&
            typeof dispatchResult.runId === "string" &&
            dispatchResult.runId.trim()
              ? dispatchResult.runId.trim()
              : null;
          if (emitListenInterceptBroadcast) {
            try {
              emitListenInterceptBroadcast({ sessionKey });
            } catch (broadcastErr) {
              logger.warn(
                `[evenai] listen intercept broadcast callback failed: ${broadcastErr && broadcastErr.message ? broadcastErr.message : broadcastErr}`,
              );
            }
          }
          emitDebug(
            "evenai",
            "listen_intercept_dispatch_succeeded",
            "info",
            {
              sessionKey,
              runId: dispatchRunId || undefined,
            },
            () => ({
              requestId,
              elapsedMs: now() - startedAtMs,
              status:
                dispatchResult &&
                typeof dispatchResult.status === "string" &&
                dispatchResult.status.trim()
                  ? dispatchResult.status.trim()
                  : null,
            }),
          );

          if (dispatchRunId) {
            try {
              await runWaiter.waitForRun({
                runId: dispatchRunId,
                sessionKey,
                timeoutMs: requestTimeoutMs,
              });
            } catch (_) {}
          }
        } catch (err) {
          let cleanupEmitted = false;
          let cleanupConnectedAppClients = null;
          let cleanupError = null;
          if (emitListenInterceptRecovery) {
            try {
              const recoveryResult = await Promise.resolve(
                emitListenInterceptRecovery({
                  requestId,
                  sessionKey,
                  error: err,
                }),
              );
              cleanupEmitted = recoveryResult
                ? recoveryResult.cleanupEmitted === true
                : true;
              cleanupConnectedAppClients =
                recoveryResult &&
                Number.isFinite(recoveryResult.connectedAppClients)
                  ? Math.floor(recoveryResult.connectedAppClients)
                  : null;
            } catch (recoveryErr) {
              cleanupError = recoveryErr;
              logger.warn(
                `[evenai] listen intercept cleanup callback failed: ${recoveryErr && recoveryErr.message ? recoveryErr.message : recoveryErr}`,
              );
            }
          }
          emitDebug(
            "evenai",
            "listen_intercept_dispatch_failed",
            "warn",
            { sessionKey },
            () => ({
              requestId,
              elapsedMs: now() - startedAtMs,
              code: err && err.code ? err.code : null,
              message: err && err.message ? err.message : String(err),
              cleanupEmitted,
              cleanupConnectedAppClients,
              cleanupError:
                cleanupError && cleanupError.message ? cleanupError.message : null,
            }),
          );
        } finally {
          interceptInflight -= 1;
        }
      })();

      writeJson(
        res,
        buildListenInterceptCloseoutPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
        }),
      );
      return true;
    }

    let route = routeDecision && routeDecision.route;
    if (routeDecision && routeDecision.kind === "local-direct" && !route) {
      const claimedOneShotAgentRef = heyEvenOneShotAgentRef;
      heyEvenOneShotAgentRef = "";
      heyEvenOneShotGeneration += 1;
      const claimedOneShotGeneration = heyEvenOneShotGeneration;
      const restoreClaimedOneShot = () => {
        if (
          claimedOneShotAgentRef &&
          heyEvenOneShotGeneration === claimedOneShotGeneration
        ) {
          heyEvenOneShotAgentRef = claimedOneShotAgentRef;
          heyEvenOneShotGeneration += 1;
        }
      };
      try {
        const bindingAgentRef = trimString(
          routeDecision.binding && routeDecision.binding.agentRef,
        );
        route = await resolveLocalTargetRoute({
          requestId,
          responseModel,
          userText,
          agentRef: claimedOneShotAgentRef || bindingAgentRef,
        });
        if (
          claimedOneShotAgentRef &&
          (
            !route ||
            route.sessionMinted !== true ||
            trimString(route.mintedAgentRef) !== claimedOneShotAgentRef
          )
        ) {
          restoreClaimedOneShot();
        }
      } catch (err) {
        restoreClaimedOneShot();
        emitDebug(
          "evenai",
          "request_routing_failed",
          "warn",
          null,
          () => ({
            requestId,
            message:
              err &&
              typeof err === "object" &&
              "message" in err &&
              typeof err.message === "string"
                ? err.message
                : String(err),
          }),
        );
        writeJson(
          res,
          buildCompletionPayload({
            id: requestId,
            createdMs: startedAtMs,
            model: responseModel,
            content: "Even AI request failed upstream. Please try again.",
          }),
        );
        return true;
      }
    }

    const sessionKey = normalizeSessionKey(route && route.sessionKey) || "main";
    const routingMode = trimString(route && route.routingMode) || "active";
    const sessionChanged = !!(route && route.sessionChanged);
    if (recordFirstSentUserMessage) {
      try {
        recordFirstSentUserMessage(sessionKey, userText);
      } catch (err) {
        logger.warn(
          `[evenai] first user message record callback failed: ${err && err.message ? err.message : err}`,
        );
      }
    }
    if (onSessionRouted) {
      try {
        onSessionRouted({
          ...route,
          sessionKey,
          routingMode,
          sessionChanged,
        });
      } catch (err) {
        logger.warn(
          `[evenai] session routed callback failed: ${err && err.message ? err.message : err}`,
        );
      }
    }
    if (sessionChanged && onSessionActivated) {
      try {
        onSessionActivated({
          ...route,
          sessionKey,
          routingMode,
        });
      } catch (err) {
        logger.warn(
          `[evenai] session activation callback failed: ${err && err.message ? err.message : err}`,
        );
      }
    }
    let finalContentSettled = false;
    const finalContentDeferred = {
      settle(_content = "") {},
    };
    const finalContentPromise = new Promise((resolve) => {
      finalContentDeferred.settle = (content = "") => {
        if (finalContentSettled) return;
        finalContentSettled = true;
        resolve(typeof content === "string" ? content : "");
      };
    });
    const settleFinalContent = finalContentDeferred.settle;
    inFlight = {
      requestId,
      fingerprint,
      sessionKey,
      startedAtMs,
      finalContentPromise,
    };
    const finalContentRecord = {
      promise: finalContentPromise,
      kind: trimString(routeDecision && routeDecision.kind) || "local-direct",
      bindingAgentRef: trimString(
        routeDecision &&
          routeDecision.binding &&
          routeDecision.binding.agentRef,
      ),
      bindingBackend:
        trimString(
          routeDecision &&
            routeDecision.binding &&
            routeDecision.binding.backend,
        ) || localBackendKind,
    };
    inFlightFinalContent.set(fingerprint, finalContentRecord);
    lastAccepted = {
      fingerprint,
      startedAtMs,
    };

    let activeRunId = null;
    let clientDisconnected = false;
    const onClientDisconnect = () => {
      if (res.writableEnded) return;
      clientDisconnected = true;

      settleFinalContent();
      if (inFlightFinalContent.get(fingerprint) === finalContentRecord) {
        inFlightFinalContent.delete(fingerprint);
      }
      if (inFlight && inFlight.requestId === requestId) {
        inFlight = null;
        emitDebug(
          "evenai",
          "request_client_disconnect",
          "info",
          { sessionKey: sessionKey || undefined, runId: activeRunId },
          () => ({
            requestId,
            elapsedMs: now() - startedAtMs,
            preAck: activeRunId == null,
          }),
        );
      }
      if (activeRunId && typeof runWaiter.cancelRun === "function") {
        try {
          runWaiter.cancelRun(activeRunId, "client_disconnect");
        } catch (_err) {

        }
      }
    };

    res.once("close", onClientDisconnect);

    emitDebug(
      "evenai",
      "request_accepted",
      "info",
      { sessionKey },
      () => ({
        requestId,
        bodyBytes: bodyResult.bodyBytes,
        messageChars: userText.length,
        model: responseModel,
        extraSystemPromptChars: systemPrompt.length,
        routingMode,
        sessionChanged,
      }),
    );

    try {
      const sendOptions = {
        prompt: {
          content: systemPrompt,
          owner: "even-ai",
          lane: "turn-scoped",
        },
      };
      const bindingAgentRef = trimString(
        route && route.sessionMinted === true && route.mintedAgentRef
          ? route.mintedAgentRef
          : routeDecision &&
              routeDecision.kind === "local-direct" &&
              routeDecision.binding &&
              routeDecision.binding.agentRef,
      );
      if (
        configuredDefaultThinking &&
        await Promise.resolve(
          shouldSeedThinkingForRoute({
            route,
            sessionKey,
            routingMode,
            thinkingLevel: configuredDefaultThinking,
          }),
        )
      ) {
        sendOptions.thinking = configuredDefaultThinking;
      }
      if (seedFastModeForRoute) {
        try {
          await Promise.resolve(
            seedFastModeForRoute({ route, sessionKey, routingMode }),
          );
        } catch (err) {

          emitDebug("evenai", "fast_mode_seed_failed", "warn", { sessionKey }, () => ({
            requestId,
            message: err && err.message ? err.message : String(err),
          }));
        }
      }
      if (seedDefaultModelForRoute) {
        try {
          await Promise.resolve(
            seedDefaultModelForRoute({ route, sessionKey, routingMode }),
          );
        } catch (err) {

          emitDebug("evenai", "default_model_seed_failed", "warn", { sessionKey }, () => ({
            requestId,
            message: err && err.message ? err.message : String(err),
          }));
        }
      }
      if (resolveAgentForRoute) {
        if (bindingAgentRef && localBackendKind !== "hermes") {
          sendOptions.agentId = bindingAgentRef;
        } else {
          try {
            const agentId = await Promise.resolve(
              resolveAgentForRoute({ route, sessionKey, routingMode }),
            );
            if (typeof agentId === "string" && agentId.trim()) {
              sendOptions.agentId = agentId.trim();
            }
          } catch (err) {

            emitDebug("evenai", "agent_resolve_failed", "warn", { sessionKey }, () => ({
              requestId,
              message: err && err.message ? err.message : String(err),
            }));
          }
        }
      } else if (bindingAgentRef && localBackendKind !== "hermes") {
        sendOptions.agentId = bindingAgentRef;
      }
      let promptTurnTicket = JSON.parse("null");
      const ack = await promiseWithTimeout(
        dispatchGatewayUserSend(sessionKey, () => {

          if (!userText.trimStart().startsWith("/")) {
            promptTurnTicket = beginPromptTurnOwnership(sessionKey, {
              owner: "even-ai",
              lane: "turn-scoped",

              sharesOcuClawSession: routingMode === "active",
            });
          }
          try {
            return Promise.resolve(
              gatewayBridge.sendMessage(userText, sessionKey, null, sendOptions),
            ).catch((err) => {
              cancelPromptTurnOwnership(promptTurnTicket);
              throw err;
            });
          } catch (err) {
            cancelPromptTurnOwnership(promptTurnTicket);
            throw err;
          }
        }),

        gatewayUserSendTimeoutMs,
      );
      const runId = trimString(ack && ack.runId);
      if (!runId) {
        cancelPromptTurnOwnership(promptTurnTicket);
        throw new Error("Even AI upstream ack was missing a runId.");
      }
      activeRunId = runId;
      if (trimString(ack && ack.status) && trimString(ack.status) !== "accepted") {
        cancelPromptTurnOwnership(promptTurnTicket);
        throw new Error(
          trimString(ack && ack.error) || `Even AI upstream returned ${ack.status}.`,
        );
      }

      emitDebug(
        "evenai",
        "request_dispatched",
        "debug",
        { sessionKey, runId },
        () => ({
          requestId,
          elapsedMs: now() - startedAtMs,
        }),
      );

      if (clientDisconnected) {
        emitDebug(
          "evenai",
          "request_wait_skipped_after_disconnect",
          "info",
          { sessionKey, runId },
          () => ({
            requestId,
            elapsedMs: now() - startedAtMs,
          }),
        );
        settleFinalContent();
        return true;
      }

      const remainingTimeoutMs = Math.max(
        1,
        requestTimeoutMs - (now() - startedAtMs),
      );
      const assistantText = await runWaiter.waitForRun({
        runId,
        sessionKey,
        timeoutMs: remainingTimeoutMs,
      });
      const filteredAssistantText = filterPlainAssistantOutputText(assistantText);
      const emptyText = !trimString(filteredAssistantText);
      const completionContent = emptyText
        ? "Even AI finished without a text reply."
        : filteredAssistantText;

      emitDebug(
        "evenai",
        "request_completed",
        "info",
        { sessionKey, runId },
        () => ({
          requestId,
          elapsedMs: now() - startedAtMs,
          textChars: assistantText.length,
          ...(emptyText ? { emptyText: true } : {}),
        }),
      );

      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
          content: completionContent,
        }),
      );
      settleFinalContent(completionContent);
      return true;
    } catch (err) {
      const handled = classifyHandledError(err);
      emitDebug(
        "evenai",
        handled.event,
        handled.severity,
        { sessionKey },
        () => ({
          requestId,
          elapsedMs: now() - startedAtMs,
          code: err && err.code ? err.code : null,
          message: err && err.message ? err.message : String(err),
        }),
      );
      writeJson(
        res,
        buildCompletionPayload({
          id: requestId,
          createdMs: startedAtMs,
          model: responseModel,
          content: handled.content,
        }),
      );
      settleFinalContent(handled.content);
      return true;
    } finally {
      settleFinalContent();
      if (inFlightFinalContent.get(fingerprint) === finalContentRecord) {
        inFlightFinalContent.delete(fingerprint);
      }
      if (inFlight && inFlight.requestId === requestId) {
        inFlight = null;
      }
      if (typeof res.removeListener === "function") {
        res.removeListener("close", onClientDisconnect);
      }
    }
  }

  const onRequest = (req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error(`[evenai] endpoint request failed: ${err.message}`);
      if (!res.writableEnded) {
        writeJson(
          res,
          buildCompletionPayload({
            content: "Even AI request failed upstream. Please try again.",
          }),
        );
      }
    });
  };

  let attached = false;
  if (enabled) {
    if (httpServer && typeof httpServer.prependListener === "function") {
      httpServer.prependListener("request", onRequest);
      attached = true;
    } else if (httpServer && typeof httpServer.on === "function") {
      httpServer.on("request", onRequest);
      attached = true;
    } else if (!externallyRouted) {
      logger.warn("[evenai] evenAiEnabled is set but no shared httpServer was provided");
    }
  }

  return {
    close() {
      if (
        attached &&
        httpServer &&
        typeof httpServer.removeListener === "function"
      ) {
        httpServer.removeListener("request", onRequest);
      }
      attached = false;
      if (ownsPeerDispatcher && typeof peerDispatcher.close === "function") {
        void peerDispatcher.close();
      }
    },

    handleRequest,
  };
}

module.exports = { EVEN_AI_LISTEN_INJECT_FIELD, EVEN_AI_PEER_FORWARD_FIELD, EVEN_AI_BINDING_AGENT_FIELD, EVEN_AI_TARGET_SESSION_FIELD, EVEN_AI_PEER_FORWARD_DEPTH_FIELD, createEvenAiEndpoint };
