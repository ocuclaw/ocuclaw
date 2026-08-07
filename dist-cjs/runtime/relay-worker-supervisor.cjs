const { EventEmitter } = require("node:events");
const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { Worker } = require("node:worker_threads");
const { APP_PROTOCOL, DEFAULT_NUDGE_THRESHOLDS, DEFAULT_WORKER_HEALTH_THRESHOLDS, DEFAULT_WORKER_QUEUE_CAPS, DEFAULT_WORKER_RPC_LIMITS, WORKER_FEATURES, formatMainOperationReceived, normalizeRequestId, parseNonNegativeRevision, } = require("./relay-worker-protocol.cjs");
const { normalizeLogger } = require("../domain/logger-adapter.cjs");

const DEFAULT_WORKER_TYPE = "commonjs";
const AUTOMATION_STATE_FALLBACK_MS = 1000;

function defaultWorkerFactory() {
  return new Worker(new URL("./relay-worker-entry.cjs", `file://${__filename}`), {
    type: DEFAULT_WORKER_TYPE,
  });
}

function normalizeFrameList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function frameMatchesOperationReceipt(frame, requestId) {
  if (!requestId || typeof frame !== "string") return false;
  try {
    const parsed = JSON.parse(frame);
    return parsed &&
      parsed.type === "ocuclaw.operation.received" &&
      parsed.requestId === requestId;
  } catch {
    return false;
  }
}

function addWorkerEpochToSendAck(frame, workerEpoch) {
  if (typeof frame !== "string") return frame;
  try {
    const parsed = JSON.parse(frame);
    if (parsed && parsed.type === "ocuclaw.message.send.ack") {
      return JSON.stringify({
        ...parsed,
        workerEpoch,
      });
    }
  } catch {
    return frame;
  }
  return frame;
}

function parseFrame(frame) {
  try {
    return JSON.parse(frame);
  } catch {
    return null;
  }
}

function responseToWorkerMessage(requestId, result) {
  const headers = result && result.headers && typeof result.headers === "object"
    ? result.headers
    : {};
  const body = result && Buffer.isBuffer(result.body)
    ? result.body
    : Buffer.from(result && result.body !== undefined ? String(result.body) : "");
  return {
    kind: "http.response",
    requestId,
    statusCode: Number.isFinite(result && result.statusCode) ? result.statusCode : 200,
    headers,
    bodyBase64: body.toString("base64"),
  };
}

function parseRequestIdFromRaw(raw) {
  return normalizeRequestId((parseFrame(raw) || {}).requestId);
}

function createRelayWorkerSupervisor(options = {}) {
  const logger = normalizeLogger(options.logger);
  const handler = options.handler || options.downstreamHandler || null;
  const operationRegistry = options.operationRegistry || null;
  const workerFactory =
    typeof options.workerFactory === "function" ? options.workerFactory : defaultWorkerFactory;
  const wssEvents = new EventEmitter();
  let worker = null;
  let workerEpoch = 0;
  let addressValue = null;
  let startPromise = null;
  let readyPromise = Promise.resolve();
  let resolveReady = null;
  let rejectReady = null;
  let closing = false;
  let activeOperationBarrier = null;
  let mainHeartbeatTimer = null;
  let restartTimer = null;
  let restartAttempt = 0;
  let workerReadyWatchdog = null;
  const clients = new Map();
  const pendingReadinessProbeRequests = new Map();
  const pendingAutomationStateRequests = new Map();
  const pendingAutomationRegistryRequests = new Map();
  let nextAutomationRegistryRequestId = 1;

  function clearPendingAutomationStateRequest(requestId) {
    const pending = pendingAutomationStateRequests.get(requestId);
    if (pending && pending.fallbackTimer) {
      clearTimeout(pending.fallbackTimer);
    }
    pendingAutomationStateRequests.delete(requestId);
    return pending || null;
  }

  function clearPendingAutomationStateRequests() {
    for (const requestId of pendingAutomationStateRequests.keys()) {
      clearPendingAutomationStateRequest(requestId);
    }
  }

  function clearPendingAutomationRegistryRequest(requestId) {
    const pending = pendingAutomationRegistryRequests.get(requestId);
    if (pending && pending.fallbackTimer) {
      clearTimeout(pending.fallbackTimer);
    }
    pendingAutomationRegistryRequests.delete(requestId);
    return pending || null;
  }

  function clearPendingAutomationRegistryRequests() {
    for (const requestId of pendingAutomationRegistryRequests.keys()) {
      clearPendingAutomationRegistryRequest(requestId);
    }
  }

  function resetReadyPromise() {
    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    readyPromise.catch(() => {});
    startPromise = readyPromise;
  }

  function postToWorker(message) {
    if (worker && typeof worker.postMessage === "function") {
      worker.postMessage(message);
    }
  }

  function mainHeartbeatIntervalMs() {
    if (Number.isFinite(options.mainHeartbeatIntervalMs)) {
      return Math.max(10, Math.floor(options.mainHeartbeatIntervalMs));
    }
    return DEFAULT_WORKER_HEALTH_THRESHOLDS.heartbeatIntervalMs;
  }

  function buildMainHeartbeat(workerEpochValue) {
    const resumeState =
      typeof options.getCurrentResumeState === "function"
        ? options.getCurrentResumeState() || {}
        : {};
    const heartbeat = {
      kind: "main.heartbeat",
      emittedAtMs: Date.now(),
      workerEpoch: workerEpochValue,
    };
    const pagesRevision = parseNonNegativeRevision(resumeState.pagesRevision);
    const statusRevision = parseNonNegativeRevision(resumeState.statusRevision);
    if (pagesRevision !== null) heartbeat.cachedPagesRevision = pagesRevision;
    if (statusRevision !== null) heartbeat.cachedStatusRevision = statusRevision;
    return heartbeat;
  }

  function stopMainHeartbeat() {
    if (!mainHeartbeatTimer) return;
    clearInterval(mainHeartbeatTimer);
    mainHeartbeatTimer = null;
  }

  function startMainHeartbeat(workerEpochValue) {
    stopMainHeartbeat();
    postToWorker(buildMainHeartbeat(workerEpochValue));
    mainHeartbeatTimer = setInterval(() => {
      postToWorker(buildMainHeartbeat(workerEpochValue));
    }, mainHeartbeatIntervalMs());
    if (typeof mainHeartbeatTimer.unref === "function") mainHeartbeatTimer.unref();
  }

  function workerRestartBackoffBaseMs() {
    return Number.isFinite(options.workerRestartBackoffBaseMs)
      ? Math.max(0, Math.floor(options.workerRestartBackoffBaseMs))
      : 250;
  }

  function workerRestartBackoffMaxMs() {
    return Number.isFinite(options.workerRestartBackoffMaxMs)
      ? Math.max(0, Math.floor(options.workerRestartBackoffMaxMs))
      : 30000;
  }

  function workerReadyWatchdogMs() {

    return Number.isFinite(options.workerReadyWatchdogMs) && options.workerReadyWatchdogMs > 0
      ? Math.floor(options.workerReadyWatchdogMs)
      : 10000;
  }

  function clearWorkerReadyWatchdog() {
    if (workerReadyWatchdog) {
      clearTimeout(workerReadyWatchdog);
      workerReadyWatchdog = null;
    }
  }

  function scheduleWorkerRestart() {
    if (restartTimer || closing) return;
    const base = Math.min(
      workerRestartBackoffMaxMs(),
      workerRestartBackoffBaseMs() * 2 ** Math.min(restartAttempt, 7),
    );
    const delay = base / 2 + Math.random() * (base / 2);
    restartAttempt += 1;
    if (typeof options.emitDebug === "function") {
      options.emitDebug(
        "relay.worker.health",
        "worker_restart_backoff",
        "warn",
        null,
        () => ({ attempt: restartAttempt, delayMs: Math.round(delay) }),
      );
    }
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (closing) return;
      startWorker();
    }, delay);
    if (typeof restartTimer.unref === "function") restartTimer.unref();
  }

  function buildManifest() {
    workerEpoch += 1;
    return {
      kind: "manifest",
      manifestId: `worker-${workerEpoch}-${Date.now()}`,
      workerEpoch,
      backendKind: getActiveBackendKind(),
      host: options.host || "127.0.0.1",
      port: Number.isFinite(options.port) ? options.port : 0,
      relayToken: options.token || "",
      pluginId: options.pluginId || "ocuclaw",
      pluginVersion:
        typeof options.getPluginVersion === "function"
          ? options.getPluginVersion()
          : "",
      requiresClientVersion:
        typeof options.getRequiresClientVersion === "function"
          ? options.getRequiresClientVersion()
          : "",
      supportedProtocolVersions: ["v2"],
      featureFlags: WORKER_FEATURES,
      routes: {
        webSocketPaths: ["/"],

        mainForwardedHttpPaths:
          options.evenAiEnabled === true ? ["/v1/chat/completions"] : [],
      },
      externalDebugToolsEnabled: options.externalDebugToolsEnabled === true,
      nudge: {
        ...DEFAULT_NUDGE_THRESHOLDS,
        ...(options.nudge || {}),
      },
      queue: {
        ...DEFAULT_WORKER_QUEUE_CAPS,
      },
      health: {
        ...DEFAULT_WORKER_HEALTH_THRESHOLDS,
      },
      rpc: {
        ...DEFAULT_WORKER_RPC_LIMITS,
        httpRequestTimeoutMs:
          Number.isFinite(options.evenAiRequestTimeoutMs)
            ? Math.max(
                DEFAULT_WORKER_RPC_LIMITS.httpRequestTimeoutMs,
                Math.floor(options.evenAiRequestTimeoutMs),
              )
            : DEFAULT_WORKER_RPC_LIMITS.httpRequestTimeoutMs,
        httpMaxBodyBytes:
          Number.isFinite(options.evenAiMaxBodyBytes)
            ? Math.max(
                DEFAULT_WORKER_RPC_LIMITS.httpMaxBodyBytes,
                Math.floor(options.evenAiMaxBodyBytes),
              )
            : DEFAULT_WORKER_RPC_LIMITS.httpMaxBodyBytes,
        httpMaxResponseBytes:
          Number.isFinite(options.evenAiMaxResponseBytes)
            ? Math.max(1, Math.floor(options.evenAiMaxResponseBytes))
            : DEFAULT_WORKER_RPC_LIMITS.httpMaxResponseBytes,
      },
      initialCache: buildInitialCache(),
    };
  }

  function buildInitialCache() {
    const initialCache = {};
    if (typeof options.getCurrentPages === "function") {
      const pages = options.getCurrentPages();
      if (typeof pages === "string") initialCache.pages = pages;
    }
    if (typeof options.getCurrentStatus === "function") {
      const status = options.getCurrentStatus();
      if (typeof status === "string") initialCache.status = status;
    }
    if (typeof options.getCurrentDebugConfig === "function") {
      const debugConfig = options.getCurrentDebugConfig();
      if (typeof debugConfig === "string") initialCache.debugConfig = debugConfig;
    }

    const resumeState =
      typeof options.getCurrentResumeState === "function"
        ? options.getCurrentResumeState() || {}
        : {};
    let pagesRevision = parseNonNegativeRevision(resumeState.pagesRevision);
    let statusRevision = parseNonNegativeRevision(resumeState.statusRevision);
    if (pagesRevision === null && initialCache.pages) {
      pagesRevision = parseNonNegativeRevision((parseFrame(initialCache.pages) || {}).revision);
    }
    if (statusRevision === null && initialCache.status) {
      statusRevision = parseNonNegativeRevision((parseFrame(initialCache.status) || {}).revision);
    }
    if (pagesRevision !== null) initialCache.pagesRevision = pagesRevision;
    if (statusRevision !== null) initialCache.statusRevision = statusRevision;
    if (initialCache.pages || initialCache.status || initialCache.debugConfig) {
      const now = Date.now();
      initialCache.lastMainFrameAtMs = now;
      if (initialCache.status) initialCache.lastMainStatusAtMs = now;
    }
    if (
      typeof options.getAgentAvatarHash === "function" &&
      typeof options.getAgentAvatarDataUriByHash === "function"
    ) {
      const hash = options.getAgentAvatarHash();
      if (typeof hash === "string" && hash) {
        const dataUri = options.getAgentAvatarDataUriByHash(hash);
        if (typeof dataUri === "string" && dataUri) {
          initialCache.agentAvatar = { hash, dataUri };
        }
      }
    }
    return initialCache;
  }

  let lastPushedAgentAvatarHash = null;
  function notifyAgentAvatarChanged(hash, dataUri) {
    const nextHash =
      typeof hash === "string" && hash && typeof dataUri === "string" && dataUri
        ? hash
        : null;
    if (nextHash === lastPushedAgentAvatarHash) return;
    lastPushedAgentAvatarHash = nextHash;
    postToWorker({
      kind: "main.avatar",
      agentAvatar: nextHash ? { hash: nextHash, dataUri } : null,
      emittedAtMs: Date.now(),
    });
  }

  function postMainFrame(target, frame, clientId) {
    if (typeof frame !== "string") return;

    const parsed = parseFrame(frame);
    const type = parsed && typeof parsed.type === "string" ? parsed.type : null;
    const message = {
      kind: "main.frame",
      target,
      clientId,
      frame,
      emittedAtMs: Date.now(),
      type,
    };
    if (type === APP_PROTOCOL.pages || type === APP_PROTOCOL.status) {
      const revision = parseNonNegativeRevision((parsed || {}).revision);
      if (revision !== null) {
        message.revisions =
          type === APP_PROTOCOL.pages
            ? { pagesRevision: revision }
            : { statusRevision: revision };
      }
    }

    if (
      activeOperationBarrier &&
      (target === "broadcast" || target === "broadcastApp") &&
      parsed &&
      normalizeRequestId(parsed.requestId) === activeOperationBarrier.requestId
    ) {
      activeOperationBarrier.frames.push(message);
      return;
    }
    postToWorker(message);
  }

  function flushOperationBarrier(barrier) {
    if (!barrier) return;
    if (activeOperationBarrier === barrier) activeOperationBarrier = null;
    for (const frame of barrier.frames) {
      postToWorker(frame);
    }
  }

  async function processResult(clientId, result, processOptions = {}) {
    const resolved = await Promise.resolve(result);
    if (!resolved) return;
    for (const frame of normalizeFrameList(resolved.unicast)) {
      const nextFrame = addWorkerEpochToSendAck(frame, workerEpoch);
      if (
        processOptions.suppressMainReceiptForRequestId &&
        frameMatchesOperationReceipt(nextFrame, processOptions.suppressMainReceiptForRequestId)
      ) {
        continue;
      }
      postMainFrame("unicast", nextFrame, clientId);
    }
    if (resolved.readinessProbe) {
      const requestId = normalizeRequestId(resolved.readinessProbe.requestId);
      const targetClientId = normalizeRequestId(resolved.readinessProbe.targetClientId);
      const message =
        typeof resolved.readinessProbe.message === "string"
          ? resolved.readinessProbe.message
          : null;
      if (!requestId || !targetClientId || !message || !isAppClient(targetClientId)) {
        postMainFrame(
          "unicast",
          formatReadinessProbeFailure(
            requestId,
            "no_downstream_client",
            "No downstream app client connected",
          ),
          clientId,
        );
      } else {
        pendingReadinessProbeRequests.set(requestId, {
          requesterClientId: clientId,
          targetClientId,
          createdAtMs: Date.now(),
        });
        postMainFrame("unicast", message, targetClientId);
      }
    }
    if (resolved.automationStateRequest) {
      const requestId = normalizeRequestId(resolved.automationStateRequest.requestId);
      const targetClientId = normalizeRequestId(resolved.automationStateRequest.targetClientId);
      const message =
        typeof resolved.automationStateRequest.message === "string"
          ? resolved.automationStateRequest.message
          : null;
      if (!requestId || !targetClientId || !message || !isAppClient(targetClientId)) {
        postMainFrame(
          "unicast",
          formatAutomationStateFailure(
            requestId,
            "snapshot_unavailable",
            "Automation state snapshot is unavailable",
          ),
          clientId,
        );
      } else {
        const fallbackTimer = setTimeout(() => {
          const pending = pendingAutomationStateRequests.get(requestId);
          if (!pending || pending.targetClientId !== targetClientId) return;
          pendingAutomationStateRequests.delete(requestId);
          postMainFrame(
            "unicast",
            formatAutomationStateFailure(
              requestId,
              "snapshot_unavailable",
              "Automation state snapshot is unavailable",
            ),
            clientId,
          );
        }, AUTOMATION_STATE_FALLBACK_MS);
        if (fallbackTimer && typeof fallbackTimer.unref === "function") {
          fallbackTimer.unref();
        }
        pendingAutomationStateRequests.set(requestId, {
          requesterClientId: clientId,
          targetClientId,
          createdAtMs: Date.now(),
          fallbackTimer,
        });
        postMainFrame("unicast", message, targetClientId);
      }
    }
    if (resolved.automationRegistryRequest) {
      const targetClientId = normalizeRequestId(resolved.automationRegistryRequest.targetClientId);
      const message =
        typeof resolved.automationRegistryRequest.message === "string"
          ? resolved.automationRegistryRequest.message
          : null;
      if (!targetClientId || !message || !isAppClient(targetClientId)) {
        postMainFrame(
          "unicast",
          JSON.stringify({
            type: "error",
            code: "automation_registry_unavailable",
            message: "Automation registry is unavailable",
          }),
          clientId,
        );
      } else {
        const requestId = `registry-${Date.now()}-${nextAutomationRegistryRequestId++}`;
        const fallbackTimer = setTimeout(() => {
          const pending = pendingAutomationRegistryRequests.get(requestId);
          if (!pending || pending.targetClientId !== targetClientId) return;
          pendingAutomationRegistryRequests.delete(requestId);
          postMainFrame(
            "unicast",
            JSON.stringify({
              type: "error",
              code: "automation_registry_unavailable",
              message: "Automation registry is unavailable",
            }),
            clientId,
          );
        }, AUTOMATION_STATE_FALLBACK_MS);
        if (fallbackTimer && typeof fallbackTimer.unref === "function") {
          fallbackTimer.unref();
        }
        pendingAutomationRegistryRequests.set(requestId, {
          requesterClientId: clientId,
          targetClientId,
          createdAtMs: Date.now(),
          fallbackTimer,
        });
        postMainFrame("unicast", message, targetClientId);
      }
    }
    for (const frame of normalizeFrameList(resolved.broadcast)) {
      postMainFrame("broadcast", frame);
    }
    for (const frame of normalizeFrameList(resolved.broadcastApp)) {
      postMainFrame("broadcastApp", frame);
    }
    if (resolved.followup) {
      await processResult(clientId, resolved.followup, processOptions);
    }
  }

  async function handleHttpRequest(message) {
    if (typeof options.handleBufferedEvenAiHttpRequest !== "function") {
      postToWorker(responseToWorkerMessage(message.requestId, {
        statusCode: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from("not found"),
      }));
      return;
    }
    try {
      const result = await Promise.resolve(options.handleBufferedEvenAiHttpRequest(message));
      postToWorker(responseToWorkerMessage(message.requestId, result));
    } catch (err) {
      logger.warn(`[relay-worker] buffered HTTP request failed: ${err && err.message ? err.message : err}`);
      postToWorker(responseToWorkerMessage(message.requestId, {
        statusCode: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: Buffer.from("relay worker HTTP bridge failed"),
      }));
    }
  }

  function handleHttpCancel(message) {
    if (typeof options.cancelBufferedEvenAiHttpRequest !== "function") {
      return;
    }
    try {
      options.cancelBufferedEvenAiHttpRequest(message);
    } catch (err) {
      logger.warn(`[relay-worker] buffered HTTP cancel failed: ${err && err.message ? err.message : err}`);
    }
  }

  function getActiveSessionKey() {
    return typeof options.getActiveSessionKey === "function"
      ? options.getActiveSessionKey() || null
      : null;
  }

  function emitRelaySession(event, sessionKey, payloadFactory) {
    if (typeof options.emitDebug !== "function") return;
    options.emitDebug(
      "relay.session",
      event,
      "info",
      { sessionKey: sessionKey || undefined },
      payloadFactory,
    );
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "worker.ready") {
      restartAttempt = 0;
      clearWorkerReadyWatchdog();
      addressValue = message.address || null;
      wssEvents.emit("listening");
      if (resolveReady) {
        resolveReady(message);
        resolveReady = null;
        rejectReady = null;
      }
      return;
    }
    if (message.kind === "worker.error") {
      logger.warn(`[relay-worker] ${message.message || "worker error"}`);

      if (rejectReady && worker && typeof worker.terminate === "function") {
        worker.terminate();
      }
      return;
    }
    if (message.kind === "worker.log") {

      const level =
        message.level === "warn" || message.level === "error" || message.level === "debug"
          ? message.level
          : "info";
      logger[level](typeof message.message === "string" ? message.message : String(message.message));
      return;
    }
    if (message.kind === "app.message") {
      if (!handler || typeof handler.handleMessage !== "function") return;
      const processOptions = {};
      if (message.operation === "message.send" && message.requestId) {
        processOptions.suppressMainReceiptForRequestId = message.requestId;
        activeOperationBarrier = {
          requestId: message.requestId,
          frames: [],
        };
        postMainFrame(
          "unicast",
          formatMainOperationReceived({
            requestId: message.requestId,
            operation: "message.send",
          }),
          message.clientId,
        );
      }
      const barrier = activeOperationBarrier;
      (async () => {
        try {
          await processResult(
            message.clientId,
            handler.handleMessage(message.clientId, message.raw),
            processOptions,
          );
        } catch (err) {
          logger.warn(`[relay-worker] app message handling failed: ${err && err.message ? err.message : err}`);
        } finally {
          flushOperationBarrier(barrier);
        }
      })();
      return;
    }
    if (message.kind === "operation.reconcile") {
      const results =
        operationRegistry && typeof operationRegistry.reconcileRequestIds === "function"
          ? operationRegistry.reconcileRequestIds(message.requestIds)
          : [];
      postToWorker({
        kind: "operation.reconcile.result",
        clientId: message.clientId,
        requestIds: message.requestIds,
        results,
      });
      return;
    }
    if (message.kind === "http.request") {
      handleHttpRequest(message);
      return;
    }
    if (message.kind === "http.cancel") {
      handleHttpCancel(message);
      return;
    }
    if (message.kind === "client.identified") {
      clients.set(message.clientId, {
        clientId: message.clientId,
        clientKind: message.clientKind || "unknown",
        clientName: message.clientName || null,
        clientVersion: message.clientVersion || null,
        clientCapabilities: Array.isArray(message.clientCapabilities)
          ? message.clientCapabilities.filter((value) => typeof value === "string" && value)
          : [],
        sessionKey: message.sessionKey || null,
        readinessSnapshot: normalizeIngestedReadinessSnapshot(message.readinessSnapshot),
        connectedAtMs: Number.isFinite(message.connectedAtMs)
          ? message.connectedAtMs
          : Date.now(),
        updatedAtMs: Date.now(),
      });
      const connectedEntry = clients.get(message.clientId) || null;
      emitRelaySession("downstream_client_connected", getActiveSessionKey(), () => ({
        clientId: message.clientId,
        connectedCount: clients.size,
        connectedAtMs: connectedEntry ? connectedEntry.connectedAtMs : null,
        remoteAddress: null,
        userAgentTail: null,
      }));
      if (
        connectedEntry &&
        connectedEntry.clientKind === "app" &&
        typeof options.onAppClientIdentified === "function"
      ) {
        try {
          options.onAppClientIdentified(message.clientId, connectedEntry);
        } catch (err) {
          logger.warn(
            `[relay-worker] app identify hook failed: ${err && err.message ? err.message : err}`,
          );
        }
      }
      return;
    }
    if (message.kind === "client.disconnected") {
      const disconnectedEntry = clients.get(message.clientId) || null;
      for (const [requestId, pending] of pendingReadinessProbeRequests) {
        if (
          pending.requesterClientId === message.clientId ||
          pending.targetClientId === message.clientId
        ) {
          pendingReadinessProbeRequests.delete(requestId);
        }
      }
      for (const [requestId, pending] of pendingAutomationStateRequests) {
        if (
          pending.requesterClientId === message.clientId ||
          pending.targetClientId === message.clientId
        ) {
          clearPendingAutomationStateRequest(requestId);
        }
      }
      for (const [requestId, pending] of pendingAutomationRegistryRequests) {
        if (
          pending.requesterClientId === message.clientId ||
          pending.targetClientId === message.clientId
        ) {
          clearPendingAutomationRegistryRequest(requestId);
        }
      }
      clients.delete(message.clientId);
      const disconnectedConnectedAtMs = disconnectedEntry ? disconnectedEntry.connectedAtMs : null;
      const disconnectedLifetimeMs = Number.isFinite(disconnectedConnectedAtMs)
        ? Math.max(0, Date.now() - disconnectedConnectedAtMs)
        : null;
      emitRelaySession("downstream_client_disconnected", getActiveSessionKey(), () => ({
        clientId: message.clientId,
        connectedCount: clients.size,
        connectedAtMs: disconnectedConnectedAtMs,
        lifetimeMs: disconnectedLifetimeMs,
        closeCode: Number.isFinite(message.closeCode) ? message.closeCode : null,
        closeReasonTail: message.closeReasonTail || null,
        role: disconnectedEntry ? disconnectedEntry.clientKind : null,
        clientKind: disconnectedEntry ? disconnectedEntry.clientKind : null,
        protocolVersion: null,
        protocolReason: null,
        clientName: disconnectedEntry ? disconnectedEntry.clientName : null,
        clientVersion: disconnectedEntry ? disconnectedEntry.clientVersion : null,
      }));
      if (
        disconnectedEntry &&
        disconnectedEntry.clientKind === "app" &&
        typeof options.onAppClientDisconnect === "function"
      ) {

        const drainSessionKey =
          typeof disconnectedEntry.sessionKey === "string" && disconnectedEntry.sessionKey
            ? disconnectedEntry.sessionKey
            : null;
        if (drainSessionKey) {
          if (getConnectedAppEntries(message.clientId, drainSessionKey).length === 0) {
            options.onAppClientDisconnect(drainSessionKey);
          }
        } else if (getConnectedAppEntries(message.clientId).length === 0) {
          options.onAppClientDisconnect(getActiveSessionKey());
        }
      }
      return;
    }

    if (message.kind === "client.goingAway") {
      const goingAwayEntry = clients.get(message.clientId) || null;
      emitRelaySession(
        "downstream_going_away",
        (goingAwayEntry && goingAwayEntry.sessionKey) || message.sessionKey || getActiveSessionKey(),
        () => ({
          clientId: message.clientId,
          reason: message.reason || null,
          clientTsMs: Number.isFinite(message.clientTsMs) ? message.clientTsMs : null,
          receivedAtMs: Number.isFinite(message.receivedAtMs) ? message.receivedAtMs : null,
          connectedCount: clients.size,
          role: goingAwayEntry ? goingAwayEntry.clientKind : null,
          clientKind: goingAwayEntry ? goingAwayEntry.clientKind : message.clientKind || null,
          clientName: goingAwayEntry ? goingAwayEntry.clientName : message.clientName || null,
        }),
      );
      return;
    }
    if (message.kind === "client.visibility") {
      const visibilityEntry = clients.get(message.clientId) || null;
      emitRelaySession(
        "downstream_transport_visibility",
        (visibilityEntry && visibilityEntry.sessionKey) || getActiveSessionKey(),
        () => ({
          clientId: message.clientId,
          state: message.state || null,
          connectedCount: clients.size,
          role: visibilityEntry ? visibilityEntry.clientKind : null,
          clientKind: visibilityEntry ? visibilityEntry.clientKind : message.clientKind || null,
          clientName: visibilityEntry ? visibilityEntry.clientName : message.clientName || null,
          clientVersion: visibilityEntry
            ? visibilityEntry.clientVersion
            : message.clientVersion || null,
          clientCapabilities: visibilityEntry
            ? visibilityEntry.clientCapabilities || []
            : Array.isArray(message.clientCapabilities)
              ? message.clientCapabilities
              : [],
          protocolVersion: message.protocolVersion || null,
        }),
      );
      return;
    }
    if (message.kind === "client.readinessSnapshot") {
      const entry = clients.get(message.clientId);
      if (entry) {
        entry.readinessSnapshot = normalizeIngestedReadinessSnapshot(message.readinessSnapshot);
        entry.updatedAtMs = Number.isFinite(message.updatedAtMs)
          ? message.updatedAtMs
          : Date.now();
      }
      return;
    }

    if (message.kind === "client.readinessProbeAck") {
      const ack = message.ack && typeof message.ack === "object" ? message.ack : null;
      const requestId = normalizeRequestId(ack && ack.requestId);
      const pending = requestId ? pendingReadinessProbeRequests.get(requestId) : null;
      if (!pending || pending.targetClientId !== message.clientId) return;
      pendingReadinessProbeRequests.delete(requestId);

      if (ack && ack.ok !== false && typeof ack.activeSessionKey === "string" && ack.activeSessionKey) {
        const ackEntry = clients.get(message.clientId);
        if (ackEntry && ackEntry.readinessSnapshot) {
          ackEntry.readinessSnapshot = {
            ...ackEntry.readinessSnapshot,
            activeSessionKey: ack.activeSessionKey,
            emittedAtMs: Number.isFinite(ack.emittedAtMs) ? ack.emittedAtMs : Date.now(),
          };
          ackEntry.updatedAtMs = Date.now();
        }
      }
      const protocol = clients.get(message.clientId) || {};
      const frame =
        handler && typeof handler.formatReadinessProbeAck === "function"
          ? handler.formatReadinessProbeAck({
              ok: ack.ok !== false,
              requestId,
              reasonCode: ack.reasonCode || null,
              message: ack.message || null,
              activeSessionKey: ack.activeSessionKey || null,
              emittedAtMs: ack.emittedAtMs,
              clientId: message.clientId,
              clientName: protocol.clientName || null,
              clientVersion: protocol.clientVersion || null,
            })
          : JSON.stringify({
              type: APP_PROTOCOL.readinessProbeAck,
              ok: ack.ok !== false,
              requestId,
              reasonCode: ack.reasonCode || null,
              message: ack.message || null,
              activeSessionKey: ack.activeSessionKey || null,
              emittedAtMs: ack.emittedAtMs,
              clientId: message.clientId,
              clientName: protocol.clientName || null,
              clientVersion: protocol.clientVersion || null,
            });
      postMainFrame("unicast", frame, pending.requesterClientId);
      return;
    }

    if (message.kind === "client.automationStateSnapshot") {
      const snapshot =
        message.snapshot && typeof message.snapshot === "object" ? message.snapshot : null;
      const requestId = normalizeRequestId(snapshot && snapshot.requestId);
      const pending = requestId ? pendingAutomationStateRequests.get(requestId) : null;
      if (!pending || pending.targetClientId !== message.clientId) return;
      clearPendingAutomationStateRequest(requestId);
      const frame =
        handler && typeof handler.formatAutomationStateSnapshot === "function"
          ? handler.formatAutomationStateSnapshot({
              ok: snapshot.ok !== false,
              requestId,
              state: snapshot.state || null,
              reasonCode: snapshot.reasonCode || null,
              message: snapshot.message || null,
            })
          : JSON.stringify({
              type: APP_PROTOCOL.automationStateSnapshot,
              ok: snapshot.ok !== false,
              requestId,
              state: snapshot.state || null,
              reasonCode: snapshot.reasonCode || null,
              message: snapshot.message || null,
            });
      postMainFrame("unicast", frame, pending.requesterClientId);
      return;
    }
    if (message.kind === "client.automationRegistry") {
      const registry =
        message.registry && typeof message.registry === "object" ? message.registry : null;
      const pendingRequests = [];
      for (const [requestId, pending] of pendingAutomationRegistryRequests) {
        if (pending.targetClientId === message.clientId) {
          pendingRequests.push([requestId, pending]);
        }
      }
      if (pendingRequests.length === 0) return;
      const registrySchemaVersion =
        registry && Number.isInteger(registry.schemaVersion) && registry.schemaVersion >= 1
          ? registry.schemaVersion
          : 1;
      const frame =
        handler && typeof handler.formatAutomationRegistry === "function"
          ? handler.formatAutomationRegistry({
              schemaVersion: registrySchemaVersion,
              entries: registry && Array.isArray(registry.entries) ? registry.entries : [],
            })
          : JSON.stringify({
              type: APP_PROTOCOL.automationRegistry,
              schemaVersion: registrySchemaVersion,
              entries: registry && Array.isArray(registry.entries) ? registry.entries : [],
            });
      for (const [requestId, pending] of pendingRequests) {
        clearPendingAutomationRegistryRequest(requestId);
        postMainFrame("unicast", frame, pending.requesterClientId);
      }
      return;
    }
    if (message.kind === "worker.backpressure") {

      if (typeof options.onWorkerBackpressure === "function") {
        options.onWorkerBackpressure(message);
      }
      return;
    }
    if (message.kind === "debug" && typeof options.emitDebug === "function") {
      options.emitDebug(
        message.category || "relay.worker.health",
        message.event || "worker_event",
        message.severity || "debug",
        null,
        () => message.data || {},
      );
    }
  }

  function start() {
    if (startPromise) return startPromise;
    closing = false;
    resetReadyPromise();
    startWorker();
    return startPromise;
  }

  function startWorker() {
    const nextWorker = workerFactory();
    worker = nextWorker;
    nextWorker.on("message", handleMessage);
    nextWorker.on("error", (err) => {
      logger.error(`[relay-worker] worker error: ${err && err.message ? err.message : err}`);

      wssEvents.emit("error", err);
    });
    const startedWorker = nextWorker;
    nextWorker.on("exit", (code) => {

      const wasActive = worker === startedWorker;
      if (!wasActive) return;
      worker = null;
      stopMainHeartbeat();
      clearWorkerReadyWatchdog();
      if (!closing) {
        const err = new Error(`relay worker exited with code ${code}`);
        logger.warn(`[relay-worker] ${err.message}`);
        const wasPreReady = Boolean(rejectReady);
        addressValue = null;
        clients.clear();
        pendingReadinessProbeRequests.clear();
        clearPendingAutomationStateRequests();
        clearPendingAutomationRegistryRequests();
        if (wssEvents.listenerCount("error") > 0) {
          wssEvents.emit("error", err);
        }

        if (!wasPreReady) {
          resetReadyPromise();
        }
        scheduleWorkerRestart();
      }
    });
    const manifest = buildManifest();
    postToWorker(manifest);
    startMainHeartbeat(manifest.workerEpoch);

    clearWorkerReadyWatchdog();
    workerReadyWatchdog = setTimeout(() => {
      workerReadyWatchdog = null;
      if (closing || worker !== startedWorker) return;
      logger.warn(
        `[relay-worker] worker did not report ready within ${workerReadyWatchdogMs()}ms; terminating`,
      );
      if (typeof startedWorker.terminate === "function") startedWorker.terminate();
    }, workerReadyWatchdogMs());
    if (typeof workerReadyWatchdog.unref === "function") workerReadyWatchdog.unref();
    return nextWorker;
  }

  function close() {
    closing = true;

    if (rejectReady) {
      rejectReady(new Error("relay worker supervisor closed before ready"));
      resolveReady = null;
      rejectReady = null;
    }
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    clearWorkerReadyWatchdog();
    stopMainHeartbeat();
    if (!worker) {
      startPromise = null;
      return Promise.resolve();
    }
    const activeWorker = worker;
    return new Promise((resolve) => {
      let resolved = false;
      function finish() {
        if (resolved) return;
        resolved = true;
        if (worker === activeWorker) worker = null;
        startPromise = null;
        addressValue = null;
        clients.clear();
        pendingReadinessProbeRequests.clear();
        clearPendingAutomationStateRequests();
        clearPendingAutomationRegistryRequests();
        resolve();
      }
      const timer = setTimeout(() => {
        activeWorker.terminate().finally(finish);
      }, 500);
      if (typeof timer.unref === "function") timer.unref();
      activeWorker.once("exit", () => {
        clearTimeout(timer);
        finish();
      });
      activeWorker.once("message", (message) => {
        if (message && message.kind === "worker.closed") {
          clearTimeout(timer);
          activeWorker.terminate().finally(finish);
        }
      });
      activeWorker.postMessage({ kind: "shutdown" });
    });
  }

  function broadcast(frame) {
    postMainFrame("broadcast", frame);
  }

  function broadcastApp(frame) {
    postMainFrame("broadcastApp", frame);
  }

  function unicast(clientId, frame) {
    postMainFrame("unicast", frame, clientId);
  }

  function getConnectedAppEntries(excludeClientId = null, sessionKey = null) {
    const entries = [];
    for (const entry of clients.values()) {
      if (entry.clientKind !== "app") continue;
      if (excludeClientId && entry.clientId === excludeClientId) continue;
      if (sessionKey != null && entry.sessionKey !== sessionKey) continue;
      entries.push(entry);
    }
    return entries;
  }

  function isAppClient(clientId) {
    const entry = clients.get(clientId);
    return entry && entry.clientKind === "app";
  }

  function formatReadinessProbeFailure(requestId, reasonCode, message) {
    if (handler && typeof handler.formatReadinessProbeAck === "function") {
      return handler.formatReadinessProbeAck({
        ok: false,
        requestId,
        reasonCode,
        message,
      });
    }
    return JSON.stringify({
      type: APP_PROTOCOL.readinessProbeAck,
      ok: false,
      requestId,
      reasonCode,
      message,
    });
  }

  function formatAutomationStateFailure(requestId, reasonCode, message) {
    if (handler && typeof handler.formatAutomationStateSnapshot === "function") {
      return handler.formatAutomationStateSnapshot({
        ok: false,
        requestId,
        reasonCode,
        message,
      });
    }
    return JSON.stringify({
      type: APP_PROTOCOL.automationStateSnapshot,
      ok: false,
      requestId,
      reasonCode,
      message,
    });
  }

  function normalizeIngestedReadinessSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") {
      return null;
    }
    if (Number.isFinite(snapshot.emittedAtMs)) {
      return snapshot;
    }
    return { ...snapshot, emittedAtMs: Date.now() };
  }

  function getReadinessSnapshot() {
    const appClients = getConnectedAppEntries();
    const updatedAtMs = appClients.reduce((latest, entry) => {
      const candidate = Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : null;
      return candidate === null ? latest : Math.max(latest || 0, candidate);
    }, null);
    return {
      connectedClientCount: appClients.length,
      fanoutRecipientCount: appClients.length,
      updatedAtMs,
      clients: appClients.map((entry) => ({
        clientId: entry.clientId,
        clientKind: entry.clientKind,
        clientName: entry.clientName,
        clientVersion: entry.clientVersion,
        clientCapabilities: entry.clientCapabilities || [],
        protocolVersion: "v2",
        protocolSessionKey: entry.sessionKey,
        readinessSnapshot: entry.readinessSnapshot,
        connectedAtMs: entry.connectedAtMs,
      })),
    };
  }

  return {
    start,
    close,
    broadcast,
    broadcastApp,
    unicast,
    notifyAgentAvatarChanged,
    getClientIds() {
      return Array.from(clients.keys());
    },
    getConnectedAppCount(excludeClientId = null, sessionKey = null) {
      return getConnectedAppEntries(excludeClientId, sessionKey).length;
    },
    getReadinessSnapshot,
    closeConnectedAppClients(opts = {}) {
      const excludeClientId =
        typeof opts.excludeClientId === "string" && opts.excludeClientId.trim()
          ? opts.excludeClientId.trim()
          : null;
      const reason =
        typeof opts.reason === "string" && opts.reason.trim()
          ? opts.reason.trim()
          : "server_close";
      const closedClientIds = getConnectedAppEntries(excludeClientId).map((entry) => entry.clientId);
      if (closedClientIds.length > 0) {
        postToWorker({
          kind: "worker.closeClients",
          clientIds: closedClientIds,
          reason,
          workerEpoch,
        });
      }
      return {
        closedCount: closedClientIds.length,
        closedClientIds,
        reason,
      };
    },
    get readyPromise() {
      return readyPromise;
    },
    get httpServer() {
      return null;
    },
    get wss() {
      return {
        address() {
          return addressValue;
        },
        on(eventName, listener) {
          wssEvents.on(eventName, listener);
          return this;
        },
        once(eventName, listener) {
          wssEvents.once(eventName, listener);
          return this;
        },
        off(eventName, listener) {
          wssEvents.off(eventName, listener);
          return this;
        },
        emit(eventName, ...args) {
          return wssEvents.emit(eventName, ...args);
        },
      };
    },
  };
}

module.exports = { createRelayWorkerSupervisor };
