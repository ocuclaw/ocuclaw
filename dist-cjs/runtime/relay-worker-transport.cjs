const http = require("node:http");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const WebSocketModule = require("ws");
const { APP_PROTOCOL, WORKER_FEATURES, estimateJsonByteLength, formatProtocolHelloAck, formatResumeAck, formatSendAck, normalizeRequestId, parseMessageType, parseNonNegativeRevision } = require("./relay-worker-protocol.cjs");
const { createWorkerMessageSendQueue } = require("./relay-worker-queue.cjs");
const { createRelayWorkerHealthMonitor } = require("./relay-worker-health.cjs");
const { createApprovalReplayCache } = require("./relay-worker-approval-replay-cache.cjs");
const { createLiveuiRenderErrorAuthority } = require("./liveui-render-error-authority.cjs");
const { createRelayClientNudgeController } = require("./relay-client-nudge-controller.cjs");
const { constantTimeEqual } = require("../domain/constant-time-equal.cjs");
const { PAIRING_CONTROL_MAX_REQUEST_BODY_BYTES, PAIRING_MAX_REQUEST_BODY_BYTES, isPairingControlPath, isPairingEndpointPath } = require("../domain/pairing/pairing-endpoint-address.cjs");
const { activeBackendDisplayName } = require("../gateway/backend-contract.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");

const WebSocket = WebSocketModule.default || WebSocketModule.WebSocket || WebSocketModule;
const WebSocketServer = WebSocketModule.WebSocketServer || WebSocketModule.Server || WebSocket.Server;
const SEND_BUFFER_HIGH_WATER_BYTES = 262_144;

const SEND_BUFFER_RETRY_MS = 50;

const SEND_BUFFER_HIGH_WATER_SHED_MS = 30_000;

const LIVENESS_MAX_MISSED_PINGS = 2;

const CONTROL_QUEUE_MAX_DEFAULT = 1000;
const TRANSACTIONAL_QUEUE_MAX_DEFAULT = 1000;

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeRequestId).filter(Boolean);
}

function responseEnded(res) {
  return res.writableEnded || res.destroyed;
}

function parseFrame(frame) {
  try {
    return JSON.parse(frame);
  } catch {
    return null;
  }
}

function createRelayWorkerTransport(options = {}) {
  const logger = normalizeLogger(options.logger);
  const postToMain = typeof options.postToMain === "function" ? options.postToMain : () => {};
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const listenRetryDelayMs =
    Number.isFinite(options.listenRetryDelayMs) && options.listenRetryDelayMs >= 0
      ? Math.floor(options.listenRetryDelayMs)
      : 200;
  const listenRetryMaxAttempts =
    Number.isFinite(options.listenRetryMaxAttempts) && options.listenRetryMaxAttempts >= 0
      ? Math.floor(options.listenRetryMaxAttempts)
      : 5;
  let manifest = null;
  let backendKind = "openclaw";
  let httpServer = null;
  let wss = null;
  let nextClientId = 1;

  const TOKEN_REJECT_LOG_WINDOW_MS = 60000;
  const TOKEN_REJECT_LOG_MAX_ADDRESSES = 100;
  const tokenRejectLogState = new Map();

  function logTokenReject(remoteAddress) {
    const at = now();
    let state = tokenRejectLogState.get(remoteAddress);
    if (!state) {
      if (tokenRejectLogState.size >= TOKEN_REJECT_LOG_MAX_ADDRESSES) {
        tokenRejectLogState.clear();
      }
      state = { lastLogAtMs: null, suppressedCount: 0 };
      tokenRejectLogState.set(remoteAddress, state);
    }
    if (state.lastLogAtMs !== null && at - state.lastLogAtMs < TOKEN_REJECT_LOG_WINDOW_MS) {
      state.suppressedCount += 1;
      return;
    }
    const suffix =
      state.suppressedCount > 0
        ? ` (+${state.suppressedCount} more rejected from this address since last log)`
        : "";
    state.lastLogAtMs = at;
    state.suppressedCount = 0;
    logger.warn(
      `[ocuclaw] relay rejected connection: invalid token remote=${remoteAddress}${suffix}`,
    );
  }
  let expireTimer = null;
  let healthTimer = null;
  let livenessTimer = null;
  let loopDelayMonitor = null;
  const clients = new Map();
  const protocolState = new Map();
  const liveuiRenderErrors = createLiveuiRenderErrorAuthority({ now });
  const outboundQueues = new Map();

  const sendBufferOverWaterSince = new Map();
  const sockets = new Set();
  const pendingHttp = new Map();
  const cache = {
    pages: null,
    entries: null,
    status: null,
    debugConfig: null,
    pagesRevision: null,
    entriesRevision: null,
    lastSeq: -1,
    statusRevision: null,
    lastMainFrameAtMs: null,
    lastMainStatusAtMs: null,
  };
  let queue = null;
  let health = null;
  let currentAgentAvatar = null;
  let nudgeController = null;
  let approvalReplay = null;

  function isAppClient(clientId) {
    return (protocolState.get(clientId) || {}).clientKind === "app";
  }

  function normalizeReadinessSnapshot(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ...value }
      : null;
  }

  function emitWorkerHealth(frame) {
    const type = parseMessageType(frame);
    if (type === APP_PROTOCOL.workerHealth) {
      try {
        const parsed = JSON.parse(frame);
        if (parsed.workerStatus === "main_disconnected") return;
      } catch {
        return;
      }
    }
    broadcastApp(frame, { afterCoalescable: true, knownType: type });
  }

  function emitDebug(event, severity, data) {
    postToMain({
      kind: "debug",
      category: "relay.worker.health",
      event,
      severity,
      data,
      workerEpoch: manifest ? manifest.workerEpoch : 0,
    });
  }

  function isMainStale() {
    if (!manifest || cache.lastMainFrameAtMs === null) return true;
    return now() - cache.lastMainFrameAtMs >= manifest.health.mainStaleResumeThresholdMs;
  }

  function cacheState() {
    if (!cache.pages && !cache.entries && !cache.status && !cache.debugConfig) return "empty";
    if (isMainStale()) return "stale";
    return "fresh";
  }

  function applyInitialCache(initialCache) {
    if (!initialCache || typeof initialCache !== "object") return;
    if (typeof initialCache.pages === "string") cache.pages = initialCache.pages;
    if (typeof initialCache.entries === "string") cache.entries = initialCache.entries;
    if (typeof initialCache.status === "string") cache.status = initialCache.status;
    if (typeof initialCache.debugConfig === "string") cache.debugConfig = initialCache.debugConfig;
    const pagesRevision = parseNonNegativeRevision(initialCache.pagesRevision);
    const entriesRevision = parseNonNegativeRevision(initialCache.entriesRevision);
    const statusRevision = parseNonNegativeRevision(initialCache.statusRevision);
    if (pagesRevision !== null) cache.pagesRevision = pagesRevision;
    if (entriesRevision !== null) cache.entriesRevision = entriesRevision;
    if (Number.isFinite(Number(initialCache.lastSeq))) cache.lastSeq = Math.floor(Number(initialCache.lastSeq));
    if (statusRevision !== null) cache.statusRevision = statusRevision;
    if (Number.isFinite(Number(initialCache.lastMainFrameAtMs))) {
      cache.lastMainFrameAtMs = Math.floor(Number(initialCache.lastMainFrameAtMs));
    } else if (cache.pages || cache.entries || cache.status || cache.debugConfig) {
      cache.lastMainFrameAtMs = now();
    }
    if (Number.isFinite(Number(initialCache.lastMainStatusAtMs))) {
      cache.lastMainStatusAtMs = Math.floor(Number(initialCache.lastMainStatusAtMs));
    } else if (cache.status) {
      cache.lastMainStatusAtMs = cache.lastMainFrameAtMs || now();
    }
    if (
      initialCache.agentAvatar &&
      typeof initialCache.agentAvatar === "object" &&
      typeof initialCache.agentAvatar.hash === "string" &&
      initialCache.agentAvatar.hash &&
      typeof initialCache.agentAvatar.dataUri === "string" &&
      initialCache.agentAvatar.dataUri
    ) {
      currentAgentAvatar = {
        hash: initialCache.agentAvatar.hash,
        dataUri: initialCache.agentAvatar.dataUri,
      };
    }
  }

  function ensureOutboundQueue(clientId) {
    let queue = outboundQueues.get(clientId);
    if (!queue) {
      queue = {
        control: [],
        transactional: [],
        coalescableByType: new Map(),
        postCoalescable: [],
        bestEffort: [],
        draining: false,
        retryTimer: null,
        pressureWarned: false,
      };
      outboundQueues.set(clientId, queue);
    }
    return queue;
  }

  function isImportantTransactionalFrame(type, parsed) {
    if (
      type === APP_PROTOCOL.messageSendAck ||
      type === "ocuclaw.approval.resolve.ack" ||
      type === "ocuclaw.approval.request" ||
      type === "ocuclaw.approval.resolved" ||
      type === "ocuclaw.remote.control"
    ) {
      return true;
    }
    if (
      typeof type === "string" &&
      (type.endsWith(".ack") || type.endsWith(".result") || type.endsWith(".applied"))
    ) {
      return true;
    }
    return !!normalizeRequestId(parsed && parsed.requestId);
  }

  function controlQueueMax() {
    const v = manifest && manifest.queue ? manifest.queue.controlQueueMax : undefined;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : CONTROL_QUEUE_MAX_DEFAULT;
  }

  function transactionalQueueMax() {
    const v = manifest && manifest.queue ? manifest.queue.transactionalQueueMax : undefined;
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : TRANSACTIONAL_QUEUE_MAX_DEFAULT;
  }

  function enqueueFrame(clientId, frame, options = {}) {
    const ws = clients.get(clientId);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const parsedFrame = parseFrame(frame);

    const type = options.knownType !== undefined ? options.knownType : parseMessageType(parsedFrame);
    const q = ensureOutboundQueue(clientId);
    if (
      options.afterCoalescable === true &&
      (type === APP_PROTOCOL.resumeAck || type === APP_PROTOCOL.workerHealth)
    ) {
      q.postCoalescable.push(frame);
    } else if (
      type === "pong" ||
      type === APP_PROTOCOL.protocolHelloAck ||
      type === APP_PROTOCOL.resumeAck ||
      type === APP_PROTOCOL.workerHealth ||
      type === APP_PROTOCOL.workerOperationReceived ||
      type === APP_PROTOCOL.operationReceived
    ) {
      q.control.push(frame);
      while (q.control.length > controlQueueMax()) {

        const dropped = q.control.shift();
        emitDebug("worker_control_frame_dropped", "warn", {
          clientId,
          droppedType: parseMessageType(parseFrame(dropped)),
          queueDepth: q.control.length,
        });
      }
    } else if (isImportantTransactionalFrame(type, parsedFrame)) {
      q.transactional.push(frame);
      while (q.transactional.length > transactionalQueueMax()) {

        const dropped = q.transactional.shift();
        emitDebug("worker_transactional_frame_dropped", "warn", {
          clientId,
          droppedType: parseMessageType(parseFrame(dropped)),
          queueDepth: q.transactional.length,
        });
      }
    } else if (
      type === APP_PROTOCOL.pages ||
      type === APP_PROTOCOL.entries ||
      type === APP_PROTOCOL.status ||
      type === APP_PROTOCOL.debugConfigSnapshot
    ) {
      q.coalescableByType.set(type, frame);
    } else {
      q.bestEffort.push(frame);
      while (q.bestEffort.length > 100) {

        const dropped = q.bestEffort.shift();
        emitDebug("worker_best_effort_frame_dropped", "warn", {
          clientId,
          droppedType: parseMessageType(parseFrame(dropped)),
          queueDepth: q.bestEffort.length,
        });
      }
    }
    drainClientQueue(clientId);
  }

  function nextQueuedFrame(q) {
    if (q.control.length) return q.control.shift();
    if (q.transactional.length) return q.transactional.shift();
    if (q.coalescableByType.size) {
      const first = q.coalescableByType.entries().next().value;
      q.coalescableByType.delete(first[0]);
      return first[1];
    }
    if (q.postCoalescable.length) return q.postCoalescable.shift();
    if (q.bestEffort.length) return q.bestEffort.shift();
    return null;
  }

  function hasQueuedFrames(q) {
    return !!(
      q &&
      (q.control.length ||
        q.transactional.length ||
        q.coalescableByType.size ||
        q.postCoalescable.length ||
        q.bestEffort.length)
    );
  }

  function drainClientQueue(clientId) {
    const ws = clients.get(clientId);
    const q = outboundQueues.get(clientId);
    if (!ws || !q || q.draining || q.retryTimer !== null || ws.readyState !== WebSocket.OPEN) return;
    const isCurrent = () => clients.get(clientId) === ws &&
      outboundQueues.get(clientId) === q && ws.readyState === WebSocket.OPEN;
    q.draining = true;
    queueMicrotask(() => {
      try {
        while (isCurrent() && hasQueuedFrames(q)) {

          if (Number.isFinite(ws.bufferedAmount) && ws.bufferedAmount > SEND_BUFFER_HIGH_WATER_BYTES) {
            if (!q.pressureWarned) {
              q.pressureWarned = true;
              emitDebug("worker_client_send_buffer_high_water", "warn", {
                clientId,
                bufferedAmountBytes: ws.bufferedAmount,
              });
            }
            break;
          }
          q.pressureWarned = false;
          ws.send(nextQueuedFrame(q));
        }
      } finally {
        q.draining = false;
        if (isCurrent() && hasQueuedFrames(q)) {
          q.retryTimer = setTimeout(() => {
            if (!isCurrent()) return;
            q.retryTimer = null;
            drainClientQueue(clientId);
          }, SEND_BUFFER_RETRY_MS);
          if (typeof q.retryTimer.unref === "function") q.retryTimer.unref();
        }
      }
    });
  }

  function clearClientQueue(clientId) {
    const q = outboundQueues.get(clientId);
    if (q && q.retryTimer !== null) clearTimeout(q.retryTimer);
    outboundQueues.delete(clientId);
  }

  function connectedAppIds() {
    return [...clients.entries()]
      .filter(([id, ws]) => ws.readyState === WebSocket.OPEN && isAppClient(id))
      .map(([id]) => id);
  }

  function broadcastApp(frame, options = {}) {
    const type = options.knownType !== undefined
      ? options.knownType
      : parseMessageType(frame);
    const liveuiFrame = type === "glasses_ui_render" || type === "glasses_ui_surface_update"
      ? parseFrame(frame) : null;
    if (liveuiFrame) liveuiRenderErrors.record(liveuiFrame, connectedAppIds());
    const hasLedgerClient = type === APP_PROTOCOL.pages && [...protocolState.values()].some(
      (state) => state.clientKind === "app" &&
        Array.isArray(state.clientCapabilities) &&
        state.clientCapabilities.includes("ledgerV1"),
    );
    const suppressPagesForLedgerClients = hasLedgerClient && parseFrame(frame)?.ledgerV1 === true;
    for (const [clientId, ws] of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const state = protocolState.get(clientId) || {};
      if (state.clientKind !== "app") continue;
      const supportsLedgerV1 = Array.isArray(state.clientCapabilities) &&
        state.clientCapabilities.includes("ledgerV1");
      if (type === APP_PROTOCOL.entries && !supportsLedgerV1) continue;
      if (type === APP_PROTOCOL.pages && suppressPagesForLedgerClients && supportsLedgerV1) continue;

      const outgoing = liveuiFrame
        ? JSON.stringify({ ...liveuiFrame, renderErrorClientId: clientId }) : frame;
      enqueueFrame(clientId, outgoing, options);
    }
  }

  function sendCachedResume(clientId, ws, parsed) {
    const previousWorkerEpoch = Number.isFinite(Number(parsed.workerEpoch))
      ? Math.floor(Number(parsed.workerEpoch))
      : null;
    const workerOnlyPendingRequestIds = normalizeStringList(parsed.workerOnlyPendingRequestIds);
    let sentPages = false;
    let sentEntries = false;
    let sentStatus = false;

    const state = protocolState.get(clientId) || {};
    const supportsLedgerV1 = Array.isArray(state.clientCapabilities) &&
      state.clientCapabilities.includes("ledgerV1");
    const entriesLaneActive = supportsLedgerV1 && !!cache.entries;
    const pagesLaneActive = !entriesLaneActive && !!cache.pages;
    if (entriesLaneActive) {
      const clientEntriesRevision = parseNonNegativeRevision(parsed.entriesRevision);
      const hasEntriesState = parsed.hasEntriesState === true;
      if (!hasEntriesState || clientEntriesRevision !== cache.entriesRevision) {
        enqueueFrame(clientId, cache.entries);
        sentEntries = true;
      }
    } else if (pagesLaneActive) {
      const clientPagesRevision = parseNonNegativeRevision(parsed.pagesRevision);
      const hasPagesState = parsed.hasPagesState === true;
      if (!hasPagesState || clientPagesRevision !== cache.pagesRevision) {
        enqueueFrame(clientId, cache.pages);
        sentPages = true;
      }
    }
    if (cache.status) {
      enqueueFrame(clientId, cache.status);
      sentStatus = true;
    }
    let sentApprovals = 0;
    if (approvalReplay) {
      for (const approvalFrame of approvalReplay.activeFrames()) {
        enqueueFrame(clientId, approvalFrame);
        sentApprovals += 1;
      }
    }
    if (cache.debugConfig && (protocolState.get(clientId) || {}).clientKind === "app") {
      enqueueFrame(clientId, cache.debugConfig);
    }

    const mainStale = isMainStale();
    const ack = formatResumeAck({
      reason: "resume",
      sentPages,
      sentEntries,
      sentStatus,
      sentApprovals,
      pagesRevision: pagesLaneActive ? cache.pagesRevision : null,
      entriesRevision: entriesLaneActive ? cache.entriesRevision : null,
      lastSeq: entriesLaneActive ? cache.lastSeq : null,
      statusRevision: cache.statusRevision,
      workerEpoch: manifest.workerEpoch,
      previousWorkerEpoch,
      workerRestarted: previousWorkerEpoch !== null && previousWorkerEpoch !== manifest.workerEpoch,
      mainStale,
      cacheState: cacheState(),
      resumeProvisional: mainStale,
      cachedPagesRevision: cache.pagesRevision,
      cachedStatusRevision: cache.statusRevision,
      workerOnlyPendingRequestIds,
      unresolvedWorkerPendingRequestIds: workerOnlyPendingRequestIds,
    });
    setTimeout(() => enqueueFrame(clientId, ack, { afterCoalescable: true }), 0);

    if (workerOnlyPendingRequestIds.length > 0) {
      postToMain({
        kind: "operation.reconcile",
        requestIds: workerOnlyPendingRequestIds,
        clientId,
        workerEpoch: manifest.workerEpoch,
      });
    }
  }

  function handleProtocolHello(clientId, ws, parsed) {
    const supported = Array.isArray(parsed.supportedProtocolVersions)
      ? parsed.supportedProtocolVersions
      : [];
    if (!supported.includes("v2")) {
      ws.close(1008, "protocol_v2_required");
      return;
    }

    const clientKind =
      parsed.clientName === "debugctl" || parsed.clientName === "director"
        ? "debug"
        : "app";
    if (clientKind === "debug" && manifest.externalDebugToolsEnabled !== true) {
      ws.close(1008, "external_debug_tools_disabled");
      return;
    }

    protocolState.set(clientId, {
      protocolVersion: "v2",
      clientKind,
      clientName: typeof parsed.clientName === "string" ? parsed.clientName : null,
      clientVersion: typeof parsed.clientVersion === "string" ? parsed.clientVersion : null,
      clientCapabilities: normalizeStringList(parsed.clientCapabilities),
      sessionKey: typeof parsed.sessionKey === "string" ? parsed.sessionKey : null,
    });
    const state = protocolState.get(clientId);
    if (state.clientKind === "app" && nudgeController) {
      nudgeController.addClient(clientId);
    }
    const identified = {
      kind: "client.identified",
      clientId,
      clientKind: state.clientKind,
      clientName: state.clientName,
      clientVersion: state.clientVersion,
      clientCapabilities: state.clientCapabilities,
      sessionKey: state.sessionKey,
      readinessSnapshot:
        parsed.readinessSnapshot && typeof parsed.readinessSnapshot === "object"
          ? parsed.readinessSnapshot
          : null,
      workerEpoch: manifest.workerEpoch,
      connectedAtMs: now(),
    };

    const pairingExchangeId =
      typeof parsed.pairingExchangeId === "string" ? parsed.pairingExchangeId : "";
    const pairingConfirmation =
      typeof parsed.pairingConfirmation === "string" ? parsed.pairingConfirmation : "";
    if (pairingExchangeId && pairingConfirmation) {
      identified.pairingExchangeId = pairingExchangeId;
      identified.pairingConfirmation = pairingConfirmation;
    }
    postToMain(identified);
    enqueueFrame(clientId, formatProtocolHelloAck({
      protocolVersion: "v2",
      supportedProtocolVersions: manifest.supportedProtocolVersions,
      reason: "negotiated_v2",
      pluginVersion: manifest.pluginVersion,
      requiresClientVersion: manifest.requiresClientVersion,
      pluginId: manifest.pluginId,
      backendKind,
      workerEpoch: manifest.workerEpoch,
      workerFeatures: WORKER_FEATURES,
    }));
  }

  function handleSend(clientId, ws, parsed, raw) {
    const requestId = normalizeRequestId(parsed.requestId);
    if (!requestId) {
      enqueueFrame(clientId, formatSendAck(null, "rejected", "Missing required field: requestId", "invalid_request"));
      return;
    }

    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (!text.trim() && !parsed.attachment) {
      enqueueFrame(clientId, formatSendAck(requestId, "rejected", "Missing required field: text", "invalid_request"));
      return;
    }

    const result = queue.enqueue({
      clientId,
      requestId,
      text,
      sessionKey: typeof parsed.sessionKey === "string" ? parsed.sessionKey : null,
      attachment: parsed.attachment || null,
    });
    health.updateQueueDepth(queue.depthSnapshot());

    if (result.receipt) enqueueFrame(clientId, result.receipt);
    if (result.finalFrame) {
      enqueueFrame(clientId, result.finalFrame);
      return;
    }

    postToMain({
      kind: "app.message",
      clientId,
      raw,
      requestId,
      operation: "message.send",
      workerEpoch: manifest.workerEpoch,
      queuedAtMs: now(),
      byteLength: estimateJsonByteLength(parsed),
    });
  }

  function handleText(clientId, ws, raw) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      enqueueFrame(clientId, JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    if (parsed && parsed.type === "ping") {
      if (nudgeController && isAppClient(clientId)) {
        nudgeController.updateHeartbeat(clientId, parsed);
      }
      enqueueFrame(clientId, JSON.stringify({ type: "pong", ts: parsed.ts }));
      return;
    }
    if (parsed && parsed.type === "protocolHello") {
      handleProtocolHello(clientId, ws, parsed);
      return;
    }

    const state = protocolState.get(clientId);
    if (!state || state.protocolVersion !== "v2") {
      ws.close(1008, "protocol_hello_required");
      return;
    }
    if (parsed && parsed.type === APP_PROTOCOL.readinessSnapshot) {
      if (isAppClient(clientId)) {
        postToMain({
          kind: "client.readinessSnapshot",
          clientId,
          readinessSnapshot: normalizeReadinessSnapshot(parsed),
          workerEpoch: manifest.workerEpoch,
          updatedAtMs: now(),
        });
      }
      return;
    }

    if (parsed && parsed.type === APP_PROTOCOL.readinessProbeAck) {
      if (isAppClient(clientId)) {
        postToMain({
          kind: "client.readinessProbeAck",
          clientId,
          ack: { ...parsed },
          workerEpoch: manifest.workerEpoch,
          receivedAtMs: now(),
        });
      }
      return;
    }

    if (parsed && parsed.type === APP_PROTOCOL.automationStateSnapshot) {
      if (isAppClient(clientId)) {
        postToMain({
          kind: "client.automationStateSnapshot",
          clientId,
          snapshot: { ...parsed },
          workerEpoch: manifest.workerEpoch,
          receivedAtMs: now(),
        });
      }
      return;
    }

    if (parsed && parsed.type === APP_PROTOCOL.automationRegistry) {
      if (isAppClient(clientId)) {
        postToMain({
          kind: "client.automationRegistry",
          clientId,
          registry: { ...parsed },
          workerEpoch: manifest.workerEpoch,
          receivedAtMs: now(),
        });
      }
      return;
    }

    if (parsed && parsed.type === APP_PROTOCOL.visibility) {
      if (isAppClient(clientId)) {
        const state =
          parsed.state === "hidden" ||
          parsed.state === "visible" ||
          parsed.state === "blurred"
            ? parsed.state
            : null;
        if (state) {
          if (nudgeController) {
            nudgeController.updateVisibilityState(clientId, state);
          }
          const ps = protocolState.get(clientId) || {};
          postToMain({
            kind: "client.visibility",
            clientId,
            state,
            sessionKey: ps.sessionKey || null,
            clientKind: ps.clientKind || null,
            clientName: ps.clientName || null,
            clientVersion: ps.clientVersion || null,
            clientCapabilities: ps.clientCapabilities || [],
            protocolVersion: ps.protocolVersion || null,
            workerEpoch: manifest.workerEpoch,
          });
        }
      }
      return;
    }

    if (parsed && parsed.type === "going_away") {
      if (isAppClient(clientId)) {
        const ps = protocolState.get(clientId) || {};
        postToMain({
          kind: "client.goingAway",
          clientId,
          reason: parsed.reason === "freeze" ? "freeze" : "pagehide",
          clientTsMs: typeof parsed.tsMs === "number" ? parsed.tsMs : null,
          sessionKey: ps.sessionKey || null,
          clientKind: ps.clientKind || null,
          clientName: ps.clientName || null,
          receivedAtMs: now(),
        });
      }
      return;
    }

    if (parsed && parsed.type === "drain_complete") {
      if (nudgeController && isAppClient(clientId)) {
        nudgeController.setInteractionStage(clientId, "idle", {
          reason: "drain_complete",
          deactivateImmediately: true,
        });
      }
      return;
    }

    if (parsed && parsed.type === APP_PROTOCOL.resumeAck.replace(".ack", "")) {
      sendCachedResume(clientId, ws, parsed);
      return;
    }
    if (parsed && parsed.type === APP_PROTOCOL.messageSend) {
      handleSend(clientId, ws, parsed, raw);
      return;
    }
    if (parsed && parsed.type === APP_PROTOCOL.avatarFetch) {
      const requestedAgentName =
        typeof parsed.agentName === "string" && parsed.agentName ? parsed.agentName : null;
      const requestedHash =
        typeof parsed.hash === "string" && /^[0-9a-f]{64}$/.test(parsed.hash)
          ? parsed.hash
          : null;
      if (!requestedAgentName || !requestedHash) {

        return;
      }
      const dataUri =
        currentAgentAvatar && currentAgentAvatar.hash === requestedHash
          ? currentAgentAvatar.dataUri
          : null;
      enqueueFrame(
        clientId,
        JSON.stringify({
          type: APP_PROTOCOL.avatarBlob,
          agentName: requestedAgentName,
          hash: requestedHash,
          dataUri,
        }),
      );
      return;
    }

    postToMain({
      kind: "app.message",
      clientId,
      raw,
      requestId: normalizeRequestId(parsed.requestId),
      ...(parsed.type === "glasses_ui_render_error" ? {
        liveuiRenderErrorAuthority: isAppClient(clientId)
          ? liveuiRenderErrors.check(clientId, parsed, connectedAppIds())
          : { eligible: false, reason: "not_app_client" },
      } : {}),
      operation: parseMessageType(parsed),
      workerEpoch: manifest.workerEpoch,
      queuedAtMs: now(),
      byteLength: estimateJsonByteLength(parsed),
    });
  }

  function handleHttpRequest(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const routes = (manifest.routes && manifest.routes.mainForwardedHttpPaths) || [];
    if (!routes.includes(url.pathname)) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("not found");
      return;
    }

    const maxBodyBytes = isPairingEndpointPath(url.pathname)
      ? PAIRING_MAX_REQUEST_BODY_BYTES
      : isPairingControlPath(url.pathname)
        ? PAIRING_CONTROL_MAX_REQUEST_BODY_BYTES
        : manifest.rpc.httpMaxBodyBytes;

    const chunks = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBodyBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", (err) => {
      logger.warn("relay worker HTTP request error", err);
      if (!responseEnded(res)) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("request error");
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        res.statusCode = 413;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("request body too large");
        return;
      }

      const requestId = `http-${manifest.workerEpoch}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timer = setTimeout(() => {
        pendingHttp.delete(requestId);
        if (!responseEnded(res)) {
          res.statusCode = 503;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(`${activeBackendDisplayName()} did not respond before the relay worker HTTP timeout.`);
        }
      }, manifest.rpc.httpRequestTimeoutMs);
      pendingHttp.set(requestId, { res, timer });
      res.once("close", () => {
        const pending = pendingHttp.get(requestId);
        if (!pending) return;
        pendingHttp.delete(requestId);
        clearTimeout(pending.timer);
        postToMain({
          kind: "http.cancel",
          requestId,
          workerEpoch: manifest.workerEpoch,
        });
      });
      postToMain({
        kind: "http.request",
        requestId,
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyBase64: Buffer.concat(chunks).toString("base64"),
        bodyBytes: total,
        workerEpoch: manifest.workerEpoch,
      });
    });
  }

  function handleMainMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "main.heartbeat") {
      if (health) {
        health.recordMainHeartbeat({
          cachedPagesRevision: cache.pagesRevision,
          cachedStatusRevision: cache.statusRevision,
          lastMainStatusAtMs: cache.lastMainStatusAtMs,
        });
      }
      return;
    }
    if (message.kind === "main.avatar") {
      const next = message.agentAvatar;
      if (
        next &&
        typeof next === "object" &&
        typeof next.hash === "string" &&
        next.hash &&
        typeof next.dataUri === "string" &&
        next.dataUri
      ) {
        currentAgentAvatar = { hash: next.hash, dataUri: next.dataUri };
      } else {
        currentAgentAvatar = null;
      }
      return;
    }
    if (message.kind === "worker.closeClients") {
      const clientIds = normalizeStringList(message.clientIds);
      const reason =
        typeof message.reason === "string" && message.reason.trim()
          ? message.reason.trim()
          : "server_close";
      for (const clientId of clientIds) {
        const ws = clients.get(clientId);
        if (!ws || !isAppClient(clientId)) continue;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1000, reason);
        }
      }
      return;
    }
    if (message.kind === "main.frame") {
      const type = typeof message.type === "string" ? message.type : parseMessageType(message.frame);
      let parsedFrame = null;
      const shouldApplyNudgeStage =
        nudgeController &&
        (message.target === "broadcast" || message.target === "broadcastApp");
      if (
        type === APP_PROTOCOL.messageSendAck ||
        type === APP_PROTOCOL.operationReceived ||
        type === APP_PROTOCOL.pages ||
        type === APP_PROTOCOL.entries ||
        type === APP_PROTOCOL.status ||
        type === APP_PROTOCOL.debugConfigSnapshot ||
        type === APP_PROTOCOL.approvalRequest ||
        type === APP_PROTOCOL.approvalResolved ||
        shouldApplyNudgeStage
      ) {
        parsedFrame = parseFrame(message.frame);
      }
      if (type === APP_PROTOCOL.approvalRequest) {
        const approvalId =
          parsedFrame && typeof parsedFrame.id === "string" && parsedFrame.id.trim()
            ? parsedFrame.id.trim()
            : null;
        if (approvalId && approvalReplay) {
          const frameExpiresAtMs =
            parsedFrame && Number.isFinite(Number(parsedFrame.expiresAtMs))
              ? Math.floor(Number(parsedFrame.expiresAtMs))
              : 0;
          approvalReplay.set(approvalId, message.frame, frameExpiresAtMs);
        }
      }
      if (type === APP_PROTOCOL.approvalResolved) {
        const approvalId =
          parsedFrame && typeof parsedFrame.id === "string" && parsedFrame.id.trim()
            ? parsedFrame.id.trim()
            : null;
        if (approvalId && approvalReplay) approvalReplay.remove(approvalId);
      }
      if (type === APP_PROTOCOL.messageSendAck || type === APP_PROTOCOL.operationReceived) {
        const requestId = normalizeRequestId(parsedFrame && parsedFrame.requestId);
        if (requestId && queue) {
          queue.settle(requestId);
          health.updateQueueDepth(queue.depthSnapshot());
        }
      }
      if (type === APP_PROTOCOL.pages) {
        cache.pages = message.frame;
        const frameRevision = parseNonNegativeRevision(parsedFrame && parsedFrame.revision);
        if (frameRevision !== null) cache.pagesRevision = frameRevision;
        if (parsedFrame?.ledgerV1 !== true) {
          cache.entries = null;
          cache.entriesRevision = 0;
          cache.lastSeq = -1;
        }
      }
      if (type === APP_PROTOCOL.entries) {
        cache.entries = message.frame;
        const frameRevision = parseNonNegativeRevision(parsedFrame && parsedFrame.entriesRevision);
        if (frameRevision !== null) cache.entriesRevision = frameRevision;
        const rawLastSeq = parsedFrame?.lastSeq;
        cache.lastSeq = rawLastSeq !== null && rawLastSeq !== undefined &&
          Number.isFinite(Number(rawLastSeq))
          ? Math.floor(Number(rawLastSeq))
          : -1;
      }
      if (type === APP_PROTOCOL.status) {
        cache.status = message.frame;
        cache.lastMainStatusAtMs = now();
        const frameRevision = parseNonNegativeRevision(parsedFrame && parsedFrame.revision);
        if (frameRevision !== null) cache.statusRevision = frameRevision;
      }
      if (type === APP_PROTOCOL.debugConfigSnapshot) cache.debugConfig = message.frame;
      if (message.revisions) {
        const pagesRevision = parseNonNegativeRevision(message.revisions.pagesRevision);
        const entriesRevision = parseNonNegativeRevision(message.revisions.entriesRevision);
        const statusRevision = parseNonNegativeRevision(message.revisions.statusRevision);
        if (pagesRevision !== null) cache.pagesRevision = pagesRevision;
        if (entriesRevision !== null) cache.entriesRevision = entriesRevision;
        if (statusRevision !== null) cache.statusRevision = statusRevision;
      }
      cache.lastMainFrameAtMs = now();
      if (message.target === "broadcast" || message.target === "broadcastApp") {
        broadcastApp(message.frame, { knownType: type });
      }
      if (message.target === "unicast" && message.clientId && clients.has(message.clientId)) {
        enqueueFrame(message.clientId, message.frame);
      }
      if (shouldApplyNudgeStage) {
        nudgeController.applyBroadcastInteractionStage(
          type,
          parsedFrame,
          type === "streaming" || type === "ocuclaw.message.stream.delta" ? now() : null,
        );
      }
      if (health) {
        health.recordMainFrame({
          type,
          cachedPagesRevision: cache.pagesRevision,
          cachedStatusRevision: cache.statusRevision,
          lastMainStatusAtMs: cache.lastMainStatusAtMs,
        });
      }
      return;
    }
    if (message.kind === "http.response") {
      const pending = pendingHttp.get(message.requestId);
      if (!pending) return;
      pendingHttp.delete(message.requestId);
      clearTimeout(pending.timer);
      const body = Buffer.from(message.bodyBase64 || "", "base64");
      if (body.length > manifest.rpc.httpMaxResponseBytes) {
        pending.res.statusCode = 502;
        pending.res.setHeader("content-type", "text/plain; charset=utf-8");
        pending.res.end(`${activeBackendDisplayName()} response exceeded relay worker HTTP response limit.`);
        return;
      }
      pending.res.statusCode = Number.isFinite(message.statusCode) ? message.statusCode : 200;
      for (const [key, value] of Object.entries(message.headers || {})) {
        pending.res.setHeader(key, value);
      }
      pending.res.end(body);
      return;
    }
    if (message.kind === "operation.reconcile.result") {
      const results = queue.reconcileOldEpochPending({
        requestIds: message.requestIds,
        mainResults: message.results,
      });
      for (const result of results) {
        if (message.clientId && clients.has(message.clientId)) {
          if (result.receiptFrame) enqueueFrame(message.clientId, result.receiptFrame);
          if (result.finalFrame) enqueueFrame(message.clientId, result.finalFrame);
        }
      }
      return;
    }
  }

  async function start(nextManifest) {
    manifest = nextManifest;
    backendKind = typeof nextManifest.backendKind === "string" && nextManifest.backendKind
      ? nextManifest.backendKind
      : "openclaw";
    nudgeController = createRelayClientNudgeController({
      thresholds: manifest.nudge || {},
      isAppClient,
      sendFrame(clientId, frame) {
        const ws = clients.get(clientId);
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        enqueueFrame(clientId, frame);
        return true;
      },
      now,
    });
    applyInitialCache(manifest.initialCache);
    queue = createWorkerMessageSendQueue({
      workerEpoch: manifest.workerEpoch,
      maxEntries: manifest.queue.messageSendMaxEntries,
      ttlMs: manifest.queue.messageSendTtlMs,
      retainedFinalTtlMs: manifest.queue.retainedFinalTtlMs,
    });
    approvalReplay = createApprovalReplayCache({
      now,
      ttlMs: manifest.queue.approvalReplayTtlMs,
      maxEntries: manifest.queue.approvalReplayMaxEntries,
    });
    health = createRelayWorkerHealthMonitor({
      workerEpoch: manifest.workerEpoch,
      thresholds: manifest.health,
      emitFrame: emitWorkerHealth,
      emitDebug,
    });
    if (cache.lastMainFrameAtMs !== null) {
      health.recordMainFrame({
        cachedPagesRevision: cache.pagesRevision,
        cachedStatusRevision: cache.statusRevision,
        lastMainStatusAtMs: cache.lastMainStatusAtMs,
      });
    } else {
      emitDebug("worker_health_transition", "info", {
        from: null,
        to: "main_disconnected",
        workerEpoch: manifest.workerEpoch,
      });
    }
    httpServer = http.createServer(handleHttpRequest);
    httpServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });

    wss = new WebSocketServer({ noServer: true, maxPayload: manifest.rpc.wsMaxMessageBytes });
    httpServer.on("upgrade", (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
    wss.on("connection", (ws, req) => {
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
      const remoteAddress = (req.socket && req.socket.remoteAddress) || "unknown";
      if (!constantTimeEqual(requestUrl.searchParams.get("token"), manifest.relayToken)) {
        logTokenReject(remoteAddress);
        ws.close(4001, "invalid_token");
        return;
      }
      const clientId = `worker-client-${nextClientId++}`;
      const connectedAtMs = now();
      logger.info(
        `[ocuclaw] relay client connected clientId=${clientId} remote=${remoteAddress}`,
      );
      clients.set(clientId, ws);

      ws.__ocuMissedPings = 0;
      ws.on("pong", () => { ws.__ocuMissedPings = 0; });
      protocolState.set(clientId, {
        protocolVersion: null,
        clientKind: "unknown",
        clientName: null,
        clientVersion: null,
        sessionKey: null,
      });
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        handleText(clientId, ws, data.toString());
      });
      ws.on("error", (err) => {
        logger.debug("relay worker WebSocket client error", err);
      });
      ws.on("close", (code, reason) => {
        clients.delete(clientId);
        liveuiRenderErrors.forgetClient(clientId);
        protocolState.delete(clientId);
        clearClientQueue(clientId);
        sendBufferOverWaterSince.delete(clientId);
        if (nudgeController) nudgeController.deleteClient(clientId);
        const closeReasonStr =
          reason == null
            ? ""
            : Buffer.isBuffer(reason)
              ? reason.toString("utf8")
              : String(reason);
        logger.info(
          `[ocuclaw] relay client disconnected clientId=${clientId} remote=${remoteAddress} code=${
            Number.isFinite(code) ? code : "none"
          } lifetimeMs=${Math.max(0, now() - connectedAtMs)}`,
        );
        postToMain({
          kind: "client.disconnected",
          clientId,
          workerEpoch: manifest.workerEpoch,
          disconnectedAtMs: now(),
          closeCode: Number.isFinite(code) ? code : null,
          closeReasonTail: closeReasonStr ? closeReasonStr.slice(-120) : null,
        });
      });
    });

    await new Promise((resolve, reject) => {
      let attempt = 0;
      let settled = false;
      const onError = (err) => {
        if (settled) return;

        if (err && err.code === "EADDRINUSE" && attempt < listenRetryMaxAttempts) {
          attempt += 1;
          emitDebug("worker_listen_retry", "warn", {
            attempt,
            code: err.code,
            port: manifest.port,
          });
          const retryTimer = setTimeout(tryListen, listenRetryDelayMs);
          if (typeof retryTimer.unref === "function") retryTimer.unref();
          return;
        }
        settled = true;
        reject(err);
      };
      const onListening = () => {
        if (settled) return;
        settled = true;
        httpServer.off("error", onError);
        resolve();
      };
      function tryListen() {
        if (settled) return;
        if (!httpServer) {

          settled = true;
          reject(new Error("relay worker transport closed during listen retry"));
          return;
        }
        httpServer.once("error", onError);
        httpServer.listen(manifest.port, manifest.host, onListening);
      }
      tryListen();
    });
    loopDelayMonitor = monitorEventLoopDelay({ resolution: 50 });
    loopDelayMonitor.enable();
    expireTimer = setInterval(() => {
      const expired = queue.expire();
      health.updateQueueDepth(queue.depthSnapshot());
      for (const item of expired) {
        if (item.clientId && clients.has(item.clientId)) {
          enqueueFrame(item.clientId, item.finalFrame);
        }
      }
    }, Math.max(10, Math.min(1000, manifest.queue.messageSendTtlMs)));
    healthTimer = setInterval(() => {
      health.updateLoopLagP95Ms(sampleLoopLagP95Ms());
      const sendBufferHighWaterClients = countSendBufferHighWaterClients();
      health.updateSendBufferHighWaterClients(sendBufferHighWaterClients);
      health.sample();

      sweepStuckSlowClients();

      postToMain({
        kind: "worker.backpressure",
        workerEpoch: manifest.workerEpoch,
        sendBufferHighWaterClients,
      });
    }, manifest.health.heartbeatIntervalMs);

    const livenessIntervalMs =
      Number.isFinite(manifest.health.livenessIntervalMs) && manifest.health.livenessIntervalMs > 0
        ? Math.floor(manifest.health.livenessIntervalMs)
        : Math.max(15000, manifest.health.heartbeatIntervalMs * 3);
    livenessTimer = setInterval(() => {
      for (const [, ws] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if ((ws.__ocuMissedPings || 0) >= LIVENESS_MAX_MISSED_PINGS) {
          ws.terminate();
          continue;
        }
        ws.__ocuMissedPings = (ws.__ocuMissedPings || 0) + 1;
        try {
          ws.ping();
        } catch {

        }
      }
    }, livenessIntervalMs);
    if (typeof livenessTimer.unref === "function") livenessTimer.unref();
    postToMain({ kind: "worker.ready", workerEpoch: manifest.workerEpoch, address: address() });
  }

  function sampleLoopLagP95Ms() {
    if (!loopDelayMonitor) return null;
    const p95Ns = loopDelayMonitor.percentile(95);
    loopDelayMonitor.reset();
    return Number.isFinite(p95Ns) ? Math.round(p95Ns / 1e6) : null;
  }

  function countSendBufferHighWaterClients() {
    let count = 0;
    for (const [clientId, ws] of clients) {
      if ((protocolState.get(clientId) || {}).clientKind !== "app") continue;
      if (
        ws.readyState === WebSocket.OPEN &&
        Number.isFinite(ws.bufferedAmount) &&
        ws.bufferedAmount > SEND_BUFFER_HIGH_WATER_BYTES
      ) {
        count += 1;
      }
    }
    return count;
  }

  function sweepStuckSlowClients() {
    const at = now();
    for (const [clientId, ws] of clients) {
      if ((protocolState.get(clientId) || {}).clientKind !== "app") continue;
      const over =
        ws.readyState === WebSocket.OPEN &&
        Number.isFinite(ws.bufferedAmount) &&
        ws.bufferedAmount > SEND_BUFFER_HIGH_WATER_BYTES;
      if (!over) {
        sendBufferOverWaterSince.delete(clientId);
        continue;
      }
      const since = sendBufferOverWaterSince.get(clientId);
      if (since === undefined) {
        sendBufferOverWaterSince.set(clientId, at);
        continue;
      }
      if (at - since >= SEND_BUFFER_HIGH_WATER_SHED_MS) {
        emitDebug("worker_client_send_buffer_shed", "warn", {
          clientId,
          bufferedAmount: ws.bufferedAmount,
          overHighWaterMs: at - since,
        });
        sendBufferOverWaterSince.delete(clientId);
        ws.terminate();
      }
    }
  }

  function address() {
    return httpServer && typeof httpServer.address === "function" ? httpServer.address() : null;
  }

  function close() {
    if (expireTimer) clearInterval(expireTimer);
    if (healthTimer) clearInterval(healthTimer);
    if (livenessTimer) clearInterval(livenessTimer);
    expireTimer = null;
    healthTimer = null;
    livenessTimer = null;
    if (loopDelayMonitor) {
      loopDelayMonitor.disable();
      loopDelayMonitor = null;
    }
    for (const pending of pendingHttp.values()) {
      clearTimeout(pending.timer);
      if (!responseEnded(pending.res)) {
        pending.res.destroy();
      }
    }
    pendingHttp.clear();
    for (const ws of clients.values()) ws.terminate();
    clients.clear();
    protocolState.clear();
    for (const clientId of outboundQueues.keys()) clearClientQueue(clientId);
    sendBufferOverWaterSince.clear();
    if (nudgeController) nudgeController.clear();
    nudgeController = null;
    if (approvalReplay) approvalReplay.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (wss) wss.close();
    return new Promise((resolve) => {
      if (!httpServer) {
        resolve();
        return;
      }
      const server = httpServer;
      let resolved = false;
      function finish() {
        if (resolved) return;
        resolved = true;
        if (httpServer === server) {
          httpServer = null;
          wss = null;
        }
        resolve();
      }
      const fallback = setTimeout(finish, 50);
      if (typeof fallback.unref === "function") fallback.unref();
      httpServer.close(() => {
        clearTimeout(fallback);
        finish();
      });
      if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
    });
  }

  return {
    start,
    close,
    address,
    handleMainMessage,
  };
}

module.exports = { createRelayWorkerTransport };
