const { parseTaggedSpans } = require("../domain/tagged-span-parser.cjs");
const { createUiRecordFamily, splitUiRecordSpans, stripReplyMarkup } = require("../domain/ui-record-family.cjs");
const { EMOJI_TAG_FAMILY_CONFIG } = require("../domain/neural-emoji-reactor-tag-config.cjs");
const { PACE_TAG_FAMILY_CONFIG } = require("../domain/neural-pace-modulator-tag-config.cjs");
const { applyMarkdownWithSpans } = require("../domain/streaming-span-markdown.cjs");

const SIMULATE_VOICE_COMMIT_DISPLAY_GATE_MS = 250;
const SIMULATE_THINKING_HEARTBEAT_INTERVAL_MS = 500;
const SIMULATE_THINKING_HEARTBEAT_CEILING_MS = 30_000;

function createRelaySimulation(ctx                        ) {
  const {
    logger,
    emitDebug,
    sessionService,
    conversationState,
    liveUiV2Session,
    relayOperationRegistry,
    ocuClawSettingsStore,
    broadcastActivity,
    broadcastPages,
    broadcastModelsCatalog,
    broadcastSessions,
    buildLocalUserMessageContent,
    cachePages,
    sendDemand,
  } = ctx;

  let simulateStreamRunSeq = 0;

  const simulateStreamRuns = new Map();

  const syntheticTimers = new Map();

  const pendingCommitPublishBySession = new Map();

  const scriptedAppSendBySession = new Map();

  const simulateToolStarts = new Map();

  const simulateThinkingBodies = new Map();

  const simulateOpenRuns = new Set();

  const simulateCompletedRuns = new Set();

  const simulateResponseStartedRuns = new Set();

  const simulateThinkingHeartbeats = new Map();

  const syntheticApprovals = new Map();

  let voiceScriptingArmed = false;

  function simulateStreamRunKey(sessionKey     , runId     ) {
    return JSON.stringify([sessionKey, runId]);
  }

  let simulatedCommitSeq = 0;
  function simulatedCommitMetadata(requestId         , runId               , kind        ) {
    simulatedCommitSeq += 1;
    const base = typeof requestId === "string" && requestId.trim()
      ? requestId.trim()
      : `${Date.now()}-${simulatedCommitSeq}`;
    return {
      id: `sim:${kind}:${base}`,
      ...(runId ? { runId } : {}),
    };
  }

  function cancelSimulateStreamRun(entry     ) {
    if (!entry || simulateStreamRuns.get(entry.key) !== entry) return 0;

    simulateStreamRuns.delete(entry.key);
    const timers        = Array.from(entry.timers);
    entry.timers.clear();
    for (const timer of timers) clearTimeout(timer);
    return timers.length;
  }

  function scheduleSimulateStreamTimer(entry     , delayMs     , callback     ) {
    const timer = setTimeout(() => {
      entry.timers.delete(timer);
      if (simulateStreamRuns.get(entry.key) !== entry) return;
      try {
        callback();
      } catch (err     ) {
        logger.error(`[relay] simulate-stream timer failed: ${err.message}`);
      }
    }, delayMs);
    entry.timers.add(timer);
    return timer;
  }

  function cancelSimulateStreamRunsForSession(sessionKey     ) {
    let cleared = 0;
    for (const entry of Array.from(simulateStreamRuns.values())) {
      if (entry.sessionKey === sessionKey) cleared += cancelSimulateStreamRun(entry);
    }
    if (cleared > 0) {
      logger.info(
        `[relay] cancelled ${cleared} pending simulate-stream timer(s) for session ${sessionKey}`,
      );
    }
    return cleared;
  }

  function cancelAllSimulateStreamRuns() {
    for (const entry of Array.from(simulateStreamRuns.values())) {
      cancelSimulateStreamRun(entry);
    }
  }

  function scheduleSyntheticTimer(delayMs     , callback     , sessionKey     ) {
    const timer = setTimeout(() => {
      syntheticTimers.delete(timer);
      try {
        callback();
      } catch (err     ) {
        logger.error(`[relay] synthetic timer failed: ${err.message}`);
      }
    }, delayMs);
    syntheticTimers.set(timer, typeof sessionKey === "string" ? sessionKey : null);
    return timer;
  }

  function dropPendingCommitPublish(sessionKey = "") {
    const pending = pendingCommitPublishBySession.get(sessionKey);
    if (!pending) return false;
    pendingCommitPublishBySession.delete(sessionKey);
    clearTimeout(pending.timer);
    syntheticTimers.delete(pending.timer);
    return true;
  }

  function flushPendingCommitPublish(sessionKey = "") {
    const pending = pendingCommitPublishBySession.get(sessionKey);
    if (!pending) return false;
    pendingCommitPublishBySession.delete(sessionKey);
    clearTimeout(pending.timer);
    syntheticTimers.delete(pending.timer);
    try {
      pending.publish();
    } catch (err) {
      logger.error(`[relay] pending commit publish flush failed: ${String(err)}`);
    }
    return true;
  }

  function clearSyntheticTimersForSession(sessionKey     ) {
    for (const [timer, timerSessionKey] of syntheticTimers) {
      if (timerSessionKey !== sessionKey) continue;
      clearTimeout(timer);
      syntheticTimers.delete(timer);
    }
    pendingCommitPublishBySession.delete(sessionKey);
    clearScriptedAppSend(sessionKey);
  }

  function clearSyntheticTimers() {
    for (const timer of syntheticTimers.keys()) clearTimeout(timer);
    syntheticTimers.clear();
    pendingCommitPublishBySession.clear();
    clearScriptedAppSend();
  }

  const SCRIPTED_APP_SEND_TTL_MS = 60_000;
  const SCRIPTED_APP_SEND_WAIT_MAX_MS = 10_000;

  function normalizeScriptedSendText(text     ) {
    return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  }

  function clearScriptedAppSend(sessionKey      = null) {
    const keys = sessionKey === null ? [...scriptedAppSendBySession.keys()] : [sessionKey];
    for (const key of keys) {
      const entry = scriptedAppSendBySession.get(key);
      if (!entry) continue;
      scriptedAppSendBySession.delete(key);
      for (const wake of [...entry.waiters]) wake();
    }
  }

  function armScriptedAppSend(sessionKey     , text     , runId     ) {
    clearScriptedAppSend(sessionKey);
    scriptedAppSendBySession.set(sessionKey, {
      text,

      runId: typeof runId === "string" && runId.trim() ? runId.trim() : null,
      expiresAtMs: Date.now() + SCRIPTED_APP_SEND_TTL_MS,
      absorbed: null,
      waiters: new Set(),
    });
  }

  function maybeAbsorbScriptedAppSend(id     , text     , sessionKey     ) {
    if (scriptedAppSendBySession.size === 0) return null;
    const key = sessionKey || sessionService.peekSessionKey() || "";
    const entry = scriptedAppSendBySession.get(key);
    if (!entry || entry.absorbed) return null;
    if (Date.now() > entry.expiresAtMs) {
      clearScriptedAppSend(key);
      return null;
    }
    const sentText = typeof text === "string" ? text : "";
    const matched = normalizeScriptedSendText(sentText) === normalizeScriptedSendText(entry.text);
    entry.absorbed = { id, matched };
    relayOperationRegistry.markStarted(id);
    relayOperationRegistry.markUpstreamAck(id, { status: "scripted", runId: entry.runId });
    conversationState.addMessage("user", buildLocalUserMessageContent(sentText, null), null, {
      clientSendId: id,
    });
    emitDebug(
      "voice.timeline",
      "scripted_app_send_absorbed",
      "info",
      { sessionKey: key },
      () => ({ messageId: id || null, textChars: sentText.length, matched }),
    );
    emitDebug(
      "openclaw.message",
      "user_message",
      "info",
      { sessionKey: key },
      () => ({ text: sentText }),
    );
    broadcastPages();
    for (const wake of [...entry.waiters]) wake();
    return Promise.resolve({
      status: "accepted",
      scripted: true,
      ...(entry.runId ? { runId: entry.runId } : {}),
    });
  }

  function awaitScriptedAppSend(sessionKey     , timeoutMs     ) {
    const entry = scriptedAppSendBySession.get(sessionKey);
    if (!entry) {
      return Promise.resolve({
        status: "rejected",
        error: "app_send_not_armed: no scripted app send is armed for this session",
        errorCode: "app_send_not_armed",
      });
    }
    const verdict = () => {
      if (scriptedAppSendBySession.get(sessionKey) === entry) scriptedAppSendBySession.delete(sessionKey);
      if (!entry.absorbed) {
        return {
          status: "rejected",
          error: "app_send_not_armed: the scripted app send was cleared before the app sent",
          errorCode: "app_send_not_armed",
        };
      }
      return entry.absorbed.matched
        ? { status: "accepted" }
        : {
          status: "rejected",
          error: "app_send_text_mismatch: the app sent different words than the scripted turn (nothing went upstream)",
          errorCode: "app_send_text_mismatch",
        };
    };
    const pending = () => ({
      status: "rejected",
      error: "app_send_pending: the app has not sent the reviewed words yet",
      errorCode: "app_send_pending",
    });
    if (entry.absorbed) return Promise.resolve(verdict());
    const waitMs = Math.max(0, Math.min(SCRIPTED_APP_SEND_WAIT_MAX_MS, Math.floor(Number(timeoutMs) || 0)));
    if (waitMs === 0) return Promise.resolve(pending());
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        entry.waiters.delete(wake);
        resolve(verdict());
      };
      const timer = setTimeout(() => {
        entry.waiters.delete(wake);
        resolve(pending());
      }, waitMs);
      entry.waiters.add(wake);
    });
  }

  function simulatedRunKeyMatchesSession(key = "", sessionKey = "") {
    try {
      const tuple = JSON.parse(key);
      return Array.isArray(tuple) && tuple[0] === (sessionKey || "");
    } catch {
      return false;
    }
  }

  function clearSimulatedRunStateForSession(sessionKey = "") {

    dropPendingCommitPublish(sessionKey);
    for (const key of Array.from(simulateThinkingHeartbeats.keys())) {
      if (simulatedRunKeyMatchesSession(key, sessionKey)) {
        cancelSimulatedThinkingHeartbeat(key);
      }
    }
    for (const key of Array.from(simulateOpenRuns)) {
      if (simulatedRunKeyMatchesSession(String(key), sessionKey)) {
        simulateOpenRuns.delete(key);
      }
    }
    for (const key of Array.from(simulateCompletedRuns)) {
      if (simulatedRunKeyMatchesSession(String(key), sessionKey)) {
        simulateCompletedRuns.delete(key);
      }
    }
    for (const key of Array.from(simulateResponseStartedRuns)) {
      if (simulatedRunKeyMatchesSession(String(key), sessionKey)) {
        simulateResponseStartedRuns.delete(key);
      }
    }
  }

  function clearSyntheticWorkForSession(sessionKey     ) {
    cancelSimulateStreamRunsForSession(sessionKey);
    clearSyntheticTimersForSession(sessionKey);
    clearSimulatedRunStateForSession(sessionKey);
  }

  function clearSyntheticWork() {
    cancelAllSimulateStreamRuns();
    clearSyntheticTimers();
    for (const key of Array.from(simulateThinkingHeartbeats.keys())) {
      cancelSimulatedThinkingHeartbeat(key);
    }
    simulateOpenRuns.clear();
    simulateCompletedRuns.clear();
    simulateResponseStartedRuns.clear();
  }

  function emitSimulatedActivity(rawActivity = JSON.parse("{}"), { nativeLifecycle = false } = {}) {

    if (rawActivity.origin === "lifecycle" && rawActivity.phase === "start") {
      flushPendingCommitPublish(
        typeof rawActivity.sessionKey === "string" ? rawActivity.sessionKey : "",
      );
    }
    if (
      nativeLifecycle &&
      ctx.upstreamRuntime &&
      typeof ctx.upstreamRuntime.ingestActivityFrame === "function"
    ) {

      ctx.upstreamRuntime.ingestActivityFrame(rawActivity, "simulated");
      return;
    }
    return broadcastActivity(rawActivity, "simulated");
  }

  function simulatedRunKey(runId = "", sessionKey = "") {
    return JSON.stringify([sessionKey || "", runId]);
  }

  function simulatedThinkingFrame(runId = "", sessionKey = "", summary = "") {
    return {
      state: "thinking",
      sessionKey,
      runId,
      origin: "thinking",
      phase: "update",
      summary,
    };
  }

  function cancelSimulatedThinkingHeartbeat(key = "") {
    const entry = simulateThinkingHeartbeats.get(key);
    if (!entry) return false;
    simulateThinkingHeartbeats.delete(key);
    clearInterval(entry.timer);
    return true;
  }

  function expireSimulatedThinkingHeartbeat(entry = JSON.parse("null")) {
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.timer = null;
    entry.expired = true;
  }

  function emitSimulatedThinkingHeartbeat(entry = JSON.parse("null")) {
    if (simulateThinkingHeartbeats.get(entry.key) !== entry) return false;
    if (!simulateOpenRuns.has(entry.key)) {
      cancelSimulatedThinkingHeartbeat(entry.key);
      return false;
    }
    if (
      entry.expired ||
      Date.now() - entry.startedAtMs >= SIMULATE_THINKING_HEARTBEAT_CEILING_MS
    ) {
      expireSimulatedThinkingHeartbeat(entry);
      return false;
    }
    emitSimulatedActivity(entry.frame, { nativeLifecycle: true });
    return true;
  }

  function startOrUpdateSimulatedThinkingHeartbeat(runId = "", sessionKey = "", summary = "") {
    const key = simulatedRunKey(runId, sessionKey);
    const frame = simulatedThinkingFrame(runId, sessionKey, summary);
    const existing = simulateThinkingHeartbeats.get(key);
    if (existing) {
      existing.frame = frame;
      return existing;
    }

    const expired = simulateResponseStartedRuns.has(key);
    const entry = {
      key,
      sessionKey,
      runId,
      frame,
      startedAtMs: Date.now(),

      timer: JSON.parse("null"),
      expired,
    };
    if (!expired) {
      entry.timer = setInterval(
        () => emitSimulatedThinkingHeartbeat(entry),
        SIMULATE_THINKING_HEARTBEAT_INTERVAL_MS,
      );
      if (typeof entry.timer.unref === "function") entry.timer.unref();
    }
    simulateThinkingHeartbeats.set(key, entry);
    return entry;
  }

  function findSimulatedThinkingHeartbeatForSession(sessionKey = "") {
    let match = null;
    for (const entry of simulateThinkingHeartbeats.values()) {
      if (entry.sessionKey === sessionKey) match = entry;
    }
    return match;
  }

  function ensureSimulatedRunOpen(runId = "", sessionKey = "", { nativeLifecycle = false } = {}) {
    const key = simulatedRunKey(runId, sessionKey);
    if (!nativeLifecycle || simulateCompletedRuns.has(key)) {
      return false;
    }
    if (simulateOpenRuns.has(key)) return true;
    simulateOpenRuns.add(key);
    emitSimulatedActivity({
      state: "thinking",
      sessionKey,
      runId,
      origin: "lifecycle",
      phase: "start",
    }, { nativeLifecycle });
    return true;
  }

  function emitSimulatedRunComplete(runId = "", sessionKey = "", { nativeLifecycle = false } = {}) {
    const key = simulatedRunKey(runId, sessionKey);
    if (nativeLifecycle) cancelSimulatedThinkingHeartbeat(key);
    if (!nativeLifecycle || simulateCompletedRuns.has(key)) {
      return false;
    }
    ensureSimulatedRunOpen(runId, sessionKey, { nativeLifecycle });
    simulateOpenRuns.delete(key);
    simulateCompletedRuns.add(key);
    simulateResponseStartedRuns.delete(key);
    emitSimulatedActivity({
      state: "idle",
      sessionKey,
      runId,
      origin: "lifecycle",
      phase: "end",
      category: "run_complete_synth",
      activityId: `run-complete-synth-${runId}`,
    }, { nativeLifecycle });
    return true;
  }

  function pruneSyntheticApprovals(nowMs     ) {
    for (const [id, entry] of syntheticApprovals) {
      if (entry.expiresAtMs + 60_000 < nowMs) syntheticApprovals.delete(id);
    }
  }

  function resolveSyntheticApproval(approvalId     , decision     , source     ) {
    const entry = syntheticApprovals.get(approvalId);
    if (!entry) return false;
    if (!entry.resolved) {
      entry.resolved = true;
      entry.decision = decision;
      if (ctx.server && ctx.handler) {
        ctx.server.broadcast(ctx.handler.formatApprovalResolved({ id: approvalId, decision }));
      }
      emitDebug(
        "approvals.timeline",
        "approval_resolved",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({ approvalId, decision, synthetic: true, source }),
      );
      const heartbeat = entry.heartbeatKey
        ? simulateThinkingHeartbeats.get(entry.heartbeatKey)
        : null;
      if (heartbeat) emitSimulatedThinkingHeartbeat(heartbeat);
    }
    return true;
  }

  const handlers = {

    onSimulate(sender     , text     , requestId = "") {
      emitDebug(
        "relay.protocol",
        "simulate",
        "debug",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          sender: sender || "Simulator",
          textChars: typeof text === "string" ? text.length : 0,
        }),
      );

      conversationState.addMessage(
        "assistant",
        [{
          type: "text",
          text: liveUiV2Session(sessionService.ensureSessionKey())
            ? stripReplyMarkup(text, { uiRecords: true })
            : text,
        }],
        sender || "Simulator",
        simulatedCommitMetadata(requestId, null, "simulate"),
      );

      const pages = conversationState.getPages();
      cachePages(pages);
      return pages;
    },

    onSimulateStream(request     ) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const nativeLifecycle = request.nativeLifecycle === true;
      const sender = (
        request.sender ||
        (ctx.upstreamRuntime ? ctx.upstreamRuntime.getAgentName() : null) ||
        "Simulator"
      ).trim();
      const text = typeof request.text === "string" ? request.text : "";

      const narration = request.messageKind === "narration";
      if (
        narration &&
        !(ctx.upstreamRuntime && typeof ctx.upstreamRuntime.ingestSimulatedGatewayEvent === "function")
      ) {
        return Promise.resolve({
          status: "rejected",
          error: "simulateStream narration not supported by relay",
        });
      }
      const chunkChars = Math.min(
        200,
        Math.max(1, request.chunkChars ?? 16),
      );
      const chunkIntervalMs = Math.min(
        5000,
        Math.max(10, request.chunkIntervalMs ?? 45),
      );
      const startDelayMs = Math.min(
        5000,
        Math.max(0, request.startDelayMs ?? 80),
      );
      const thinkingTailMs = Math.min(
        10000,
        Math.max(0, request.thinkingTailMs ?? 900),
      );
      const runId = request.runId || `sim-${Date.now()}-${++simulateStreamRunSeq}`;

      const narrationMessageId = request.messageId || `${runId}:narration`;
      const nativeRunIsEmittable = nativeLifecycle
        ? ensureSimulatedRunOpen(runId, sessionKey, { nativeLifecycle })
        : false;
      const key = simulateStreamRunKey(sessionKey, runId);
      const superseded = simulateStreamRuns.get(key);
      const supersededTimerCount = superseded
        ? cancelSimulateStreamRun(superseded)
        : 0;
      const streamRun = {
        key,
        sessionKey,
        runId,
        timers: new Set(),
        nativeFirstChunkHandled: false,
      };
      simulateStreamRuns.set(key, streamRun);
      const chunkCount = Math.max(1, Math.ceil(text.length / chunkChars));
      const streamPrefix = `${sender}: `;

      emitDebug(
        "relay.protocol",
        "simulate_stream_start",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          sender,
          textChars: text.length,
          chunkChars,
          chunkIntervalMs,
          startDelayMs,
          thinkingTailMs,
          chunkCount,
          supersededTimerCount,
          messageKind: narration ? "narration" : null,
        }),
      );

      if (!nativeLifecycle) {
        broadcastActivity({
          state: "thinking",
          sessionKey,
          runId,
          origin: "simulate",
          phase: "start",
        }, "simulated");
      }

      for (let index = 0; index < chunkCount; index += 1) {
        const visibleChars = Math.min(text.length, (index + 1) * chunkChars);
        const delayMs = startDelayMs + (index * chunkIntervalMs);
        scheduleSimulateStreamTimer(streamRun, delayMs, () => {

          if (
            nativeRunIsEmittable &&
            !narration &&
            !streamRun.nativeFirstChunkHandled
          ) {
            streamRun.nativeFirstChunkHandled = true;
            cancelSimulatedThinkingHeartbeat(
              simulatedRunKey(runId, sessionKey),
            );
            const runKey = simulatedRunKey(runId, sessionKey);
            if (
              simulateOpenRuns.has(runKey) &&
              !simulateResponseStartedRuns.has(runKey)
            ) {
              simulateResponseStartedRuns.add(runKey);
              if (
                ctx.upstreamRuntime &&
                typeof ctx.upstreamRuntime.synthesizeResponseStarted === "function"
              ) {
                ctx.upstreamRuntime.synthesizeResponseStarted(runId, sessionKey);
              }
            }
          }
          if (narration && ctx.upstreamRuntime) {

            ctx.upstreamRuntime.ingestSimulatedGatewayEvent("streaming", {
              runId,
              sessionKey,
              text: text.slice(0, visibleChars),
              messageId: narrationMessageId,
              messageKind: "narration",
            });
          } else {

            const uiRecords = liveUiV2Session(sessionKey);
            const parsedSpans = parseTaggedSpans(
              text.slice(0, visibleChars),
              uiRecords
                ? [EMOJI_TAG_FAMILY_CONFIG, PACE_TAG_FAMILY_CONFIG, createUiRecordFamily()]
                : [EMOJI_TAG_FAMILY_CONFIG, PACE_TAG_FAMILY_CONFIG],
            );
            const { text: streamedText, spansByFamily }      = applyMarkdownWithSpans(
              uiRecords
                ? {
                    ...parsedSpans,
                    spansByFamily: splitUiRecordSpans(parsedSpans.spansByFamily).spansByFamily,
                  }
                : parsedSpans,
              streamPrefix,
              conversationState,
            );
            ctx.server.broadcast(ctx.handler.formatStreaming(
              streamedText,
              spansByFamily.emoji || [],
              spansByFamily.pace || [],
              { runId, seq: index + 1 },
            ));
          }
          emitDebug(
            "relay.protocol",
            "simulate_stream_chunk",
            "debug",
            { sessionKey, runId },
            () => ({
              chunkIndex: index + 1,
              chunkCount,
              visibleChars,
              totalChars: text.length,
            }),
          );
        });
      }

      const completeDelayMs = startDelayMs + (chunkCount * chunkIntervalMs) + thinkingTailMs;
      scheduleSimulateStreamTimer(streamRun, completeDelayMs, () => {
        try {
          if (narration && ctx.upstreamRuntime) {

            ctx.upstreamRuntime.ingestSimulatedGatewayEvent("message", {
              role: "assistant",
              content: [{ type: "text", text }],
              runId,
              sessionKey,
              id: narrationMessageId,
              messageKind: "narration",
              turnActive: true,
            });
          } else {

            conversationState.addMessage(
              "assistant",
              [{
                type: "text",
                text: stripReplyMarkup(text, { uiRecords: liveUiV2Session(sessionKey) }),
              }],
              sender,
              simulatedCommitMetadata(request.id, runId, "stream"),
            );
            broadcastPages();
          }
          if (nativeLifecycle) {

            if (nativeRunIsEmittable && request.continuesRun !== true) {
              emitSimulatedRunComplete(runId, sessionKey, { nativeLifecycle });
            }
          } else {
            broadcastActivity({
              state: "idle",
              sessionKey,
              runId,
              origin: "simulate",
              phase: "complete",
            }, "simulated");
          }
          emitDebug(
            "relay.protocol",
            "simulate_stream_complete",
            "info",
            { sessionKey, runId },
            () => ({
              messageId: request.id || null,
              textChars: text.length,
              chunkCount,
              thinkingTailMs,
              completeDelayMs,
            }),
          );
        } finally {
          if (simulateStreamRuns.get(key) === streamRun) {
            simulateStreamRuns.delete(key);
          }
        }
      });

      return Promise.resolve({
        status: "accepted",
        runId,
      });
    },

    onSimulateStreamCancel(request     ) {
      const runId = request.runId;
      let entry = null;
      if (request.sessionKey) {
        entry = simulateStreamRuns.get(
          simulateStreamRunKey(request.sessionKey, runId),
        ) || null;
      } else {
        const matches = Array.from(simulateStreamRuns.values())
          .filter((candidate) => candidate.runId === runId);
        if (matches.length > 1) {
          return Promise.resolve({
            status: "rejected",
            error: `simulateStreamCancel runId ${runId} matches multiple sessions`,
            errorCode: "ambiguous_run_id",
            runId,
          });
        }
        entry = matches[0] || null;
      }

      const sessionKey = entry
        ? entry.sessionKey
        : request.sessionKey || null;
      const clearedTimerCount = entry ? cancelSimulateStreamRun(entry) : 0;
      emitDebug(
        "relay.protocol",
        "simulate_stream_cancel",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          found: !!entry,
          clearedTimerCount,
        }),
      );
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateModelCatalog(request     ) {
      const models = Array.isArray(request.models) ? request.models : null;
      const snapshot = ctx.upstreamRuntime.setSimulatedModelCatalog(models);
      emitDebug(
        "relay.protocol",
        "simulate_model_catalog",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          messageId: request.id || null,
          pinned: models !== null,
          count: models ? models.length : 0,
        }),
      );
      broadcastModelsCatalog(snapshot);
      return Promise.resolve({ status: "accepted" });
    },

    onSimulateSessionList(request     ) {
      const rows =
        request.rows === undefined || request.rows === null ? null : request.rows;
      return sessionService.setSimulatedSessionList(rows).then((result     ) => {
        emitDebug(
          "relay.protocol",
          "simulate_session_list",
          "info",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            messageId: request.id || null,
            pinned: result.pinned,
            count: result.count,
            report: result.report,
          }),
        );
        return broadcastSessions().then(() => ({
          status: "accepted",
          sessionList: {
            pinned: result.pinned,
            count: result.count,
            anchorMs: result.anchorMs,
            ...(result.report || {}),
          },
        }));
      });
    },

    onSimulateActivity(request     ) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const runId = request.runId || `sim-${Date.now()}-${++simulateStreamRunSeq}`;
      const summary = request.summary || null;
      const nativeLifecycle = request.nativeLifecycle === true;
      emitDebug(
        "relay.protocol",
        "simulate_activity",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          state: request.state,
          hasSummary: !!summary,
        }),
      );
      if (nativeLifecycle) {
        if (request.state === "thinking") {
          const runIsEmittable = ensureSimulatedRunOpen(
            runId,
            sessionKey,
            { nativeLifecycle },
          );
          if (runIsEmittable && summary) {
            const heartbeat = startOrUpdateSimulatedThinkingHeartbeat(
              runId,
              sessionKey,
              summary,
            );
            emitSimulatedActivity(heartbeat.frame, { nativeLifecycle });
          }
        } else {
          emitSimulatedRunComplete(runId, sessionKey, { nativeLifecycle });
        }
      } else if (request.state === "thinking") {
        broadcastActivity({
          state: "thinking",
          sessionKey,
          runId,
          origin: "lifecycle",
          phase: "start",
        }, "simulated");
        if (summary) {
          broadcastActivity({
            state: "thinking",
            sessionKey,
            runId,
            origin: "thinking",
            phase: "update",
            summary,
          }, "simulated");
        }
      } else {
        broadcastActivity({
          state: "idle",
          sessionKey,
          runId,
          origin: "lifecycle",
          phase: "end",
        }, "simulated");
      }
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateTool(request     ) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const { runId, phase, tool } = request;
      const args = request.argsPreview || null;
      const nativeLifecycle = request.nativeLifecycle === true;
      const nowMs = Date.now();
      let elapsedMs = null;
      const withToolPhase = request.toolPhase === true;
      const toolCallId = request.toolCallId || `${runId}:tool:${tool}`;
      if (phase === "start") {
        simulateToolStarts.set(runId, nowMs);
        if (simulateToolStarts.size > 200) {
          const oldest = simulateToolStarts.keys().next();
          if (!oldest.done) simulateToolStarts.delete(oldest.value);
        }
        const activity      = {
          state: "thinking",
          tool,
          sessionKey,
          runId,
          origin: "tool",
          phase: "start",
        };
        if (args) activity.args = args;
        if (withToolPhase) {
          Object.assign(activity, {
            toolPhase: "start",
            activityId: toolCallId,
            toolCallId,
          });
        }
        if (nativeLifecycle) {
          if (ensureSimulatedRunOpen(runId, sessionKey, { nativeLifecycle })) {
            emitSimulatedActivity(activity, { nativeLifecycle });
          }
        } else {
          broadcastActivity(activity, "simulated");
        }
      } else {

        elapsedMs = Number.isFinite(request.elapsedMs)
          ? Math.max(0, Math.floor(request.elapsedMs))
          : simulateToolStarts.has(runId)
            ? Math.max(0, nowMs - simulateToolStarts.get(runId))
            : null;
        simulateToolStarts.delete(runId);
        if (withToolPhase) {

          const endActivity = {
            state: "thinking",
            tool,
            sessionKey,
            runId,
            origin: "tool",
            phase: "update",
          };
          Object.assign(
            endActivity,
            { toolPhase: "end", activityId: toolCallId, toolCallId },
            request.isError === true ? { isError: true } : {},
          );
          if (nativeLifecycle) {
            if (ensureSimulatedRunOpen(runId, sessionKey, { nativeLifecycle })) {
              emitSimulatedActivity(endActivity, { nativeLifecycle });
            }
          } else {
            broadcastActivity(endActivity, "simulated");
          }
        }
      }
      emitDebug(
        "openclaw.run",
        "gateway_event_received",
        "debug",
        { sessionKey, runId },
        () => ({
          eventKind: "agent",
          runId,
          sessionKey,
          source: "simulate",
          stream: "tool",
          phase,
          tool,
          ...(phase === "result"
            ? { elapsedMs, isError: request.isError === true }
            : {}),
        }),
      );
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateThinking(request = JSON.parse("{}")) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const runId = request.runId;
      if (!ctx.upstreamRuntime || typeof ctx.upstreamRuntime.ingestSimulatedGatewayEvent !== "function") {
        return Promise.resolve({
          status: "rejected",
          error: "simulateThinking not supported by relay",
        });
      }
      const key = simulatedRunKey(runId, sessionKey);
      const body = simulateThinkingBodies.get(key) || { text: "", seq: 0 };
      simulateThinkingBodies.delete(key);
      simulateThinkingBodies.set(key, body);
      if (simulateThinkingBodies.size > 200) {
        const oldest = simulateThinkingBodies.keys().next();
        if (!oldest.done) simulateThinkingBodies.delete(oldest.value);
      }
      body.seq += 1;
      if (request.phase === "update") {
        body.text = body.text ? `${body.text}\n\n${request.delta}` : request.delta;
        ctx.upstreamRuntime.ingestSimulatedGatewayEvent("thinking", {
          phase: "update",
          runId,
          sessionKey,
          text: body.text,
          delta: request.delta,
          seq: body.seq,
          source: "simulate",
        });
      } else {
        ctx.upstreamRuntime.ingestSimulatedGatewayEvent("thinking", {
          phase: "finalize",
          runId,
          sessionKey,
          reason: request.reason || "response_started",
          seq: body.seq,
        });
      }
      emitDebug(
        "relay.protocol",
        "simulate_thinking",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          phase: request.phase,
          seq: body.seq,
          textChars: body.text.length,
          reason: request.phase === "finalize" ? request.reason || "response_started" : null,
        }),
      );
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateRunSignal(request = JSON.parse("{}")) {
      if (!ctx.upstreamRuntime || typeof ctx.upstreamRuntime.ingestSimulatedGatewayEvent !== "function") {
        return Promise.resolve({
          status: "rejected",
          error: "simulateRunSignal not supported by relay",
        });
      }
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const runId = request.runId || null;
      ctx.upstreamRuntime.ingestSimulatedGatewayEvent("runSignal", {
        signal: request.signal,
        phase: request.phase,
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(request.spanId ? { spanId: request.spanId } : {}),
        ...(request.outcome ? { outcome: request.outcome } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
        ...(request.label ? { label: request.label } : {}),
        ...(typeof request.waitMs === "number" ? { retryAtMs: Date.now() + request.waitMs } : {}),
      });
      emitDebug(
        "relay.protocol",
        "simulate_run_signal",
        "info",
        { sessionKey, runId },
        () => ({
          messageId: request.id || null,
          signal: request.signal,
          phase: request.phase,
          spanId: request.spanId || null,
        }),
      );
      return Promise.resolve({ status: "accepted", runId });
    },

    onSimulateDemand(request     ) {
      sendDemand({
        surfaceId: request.surfaceId,
        sessionKey: request.sessionKey || sessionService.ensureSessionKey(),
        kind: request.kind,
        title: request.title,
        question: request.question,
        deadlineSec: request.deadlineSec,
        questionIndex: request.questionIndex,
        questionCount: request.questionCount,

        presentation: request.presentation,
        selectionMode: request.selectionMode,
        allowOther: request.allowOther,
        options: request.options,
      });
      return { status: "accepted" };
    },

    onSimulateApproval(request     ) {
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      const nativeLifecycle = request.nativeLifecycle === true;
      const approvalId = request.approvalId;
      const nowMs = Date.now();
      pruneSyntheticApprovals(nowMs);
      if (request.phase === "request") {
        const expiresAtMs = nowMs + request.expiresInMs;
        syntheticApprovals.set(approvalId, {
          resolved: false,
          decision: null,
          expiresAtMs,

          heartbeatKey: nativeLifecycle
            ? findSimulatedThinkingHeartbeatForSession(sessionKey)?.key || null
            : null,
        });
        emitDebug(
          "approvals.timeline",
          "approval_requested",
          "info",
          { sessionKey },
          () => ({
            approvalId,
            approvalKind: "exec",
            synthetic: true,
            commandLength: (request.command || "").length,
          }),
        );
        if (ctx.server && ctx.handler) {
          ctx.server.broadcast(ctx.handler.formatApproval({
            id: approvalId,
            createdAtMs: nowMs,
            expiresAtMs,
            request: {
              command: request.command,
              ask: request.ask || null,
              warningText: request.warningText || null,
              warningLines: request.warningLines || [],
              allowedDecisions: request.allowedDecisions,
              sessionKey,
              cwd: request.cwd || null,
              agentId: request.agentId || null,
              purpose: request.purpose || null,
              botScreen: request.botScreen || null,
            },
          }));

          if (request.explanation && ocuClawSettingsStore.getSnapshot().explainApprovals !== false) {

            if (typeof ctx.handler.formatApprovalExplanationPending === "function") {
              ctx.server.broadcast(ctx.handler.formatApprovalExplanationPending({ id: approvalId, pending: true }));
            }
            const explanationTimer      = setTimeout(() => {
              const entry = syntheticApprovals.get(approvalId);
              if (!entry || entry.resolved || !ctx.server || !ctx.handler) return;
              const frame = ctx.handler.formatApprovalExplanation({
                id: approvalId,
                explanation: request.explanation,
              });
              if (frame) ctx.server.broadcast(frame);
            }, request.explanationDelayMs || 0);
            if (explanationTimer && typeof explanationTimer.unref === "function") explanationTimer.unref();
          }
        }
        return Promise.resolve({ status: "accepted" });
      }
      if (!syntheticApprovals.has(approvalId)) {
        return Promise.resolve({
          status: "rejected",
          error: `unknown synthetic approval id: ${approvalId}`,
        });
      }
      resolveSyntheticApproval(approvalId, request.decision, "scripted");
      return Promise.resolve({ status: "accepted" });
    },

    onSimulateVoice(request     ) {
      const phase = request.phase;
      const text = typeof request.text === "string" ? request.text : "";
      if (phase === "await-send") {
        const awaitKey = (typeof request.sessionKey === "string" && request.sessionKey.trim())
          || sessionService.peekSessionKey() || "";
        return awaitScriptedAppSend(awaitKey, request.timeoutMs);
      }

      if (phase === "reopen") {

        const rawReopenKey =
          typeof request.sessionKey === "string" ? request.sessionKey.trim() : "";
        const peekedReopenKey = sessionService.peekSessionKey();
        const activeReopenKey =
          typeof peekedReopenKey === "string" ? peekedReopenKey.trim() : "";
        const reopenSessionKey = rawReopenKey || activeReopenKey;
        if (!reopenSessionKey) {
          return Promise.resolve({
            status: "rejected",
            error: "simulateVoice reopen requires an active session",
          });
        }
        emitDebug(
          "voice.timeline",
          "simulate_voice",
          "info",
          { sessionKey: reopenSessionKey },
          () => ({
            messageId: request.id || null,
            phase,
            textChars: text.length,
          }),
          undefined,
        );
        if (!ctx.server || !ctx.handler) {
          return Promise.resolve({
            status: "rejected",
            error: "relay not ready for simulateVoice broadcast",
          });
        }
        ctx.server.broadcast(ctx.handler.formatScriptedListenReady(reopenSessionKey));
        return Promise.resolve({ status: "accepted" });
      }
      const sessionKey = request.sessionKey || sessionService.ensureSessionKey();
      emitDebug(
        "voice.timeline",
        "simulate_voice",
        phase === "partial" ? "debug" : "info",
        { sessionKey },
        () => ({
          messageId: request.id || null,
          phase,
          textChars: text.length,
        }),
      );
      if (phase === "arm" || phase === "disarm") {
        voiceScriptingArmed = phase === "arm";

        if (phase === "disarm") clearScriptedAppSend();
        return Promise.resolve({ status: "accepted" });
      }
      if (!ctx.server || !ctx.handler) {
        return Promise.resolve({
          status: "rejected",
          error: "relay not ready for simulateVoice broadcast",
        });
      }
      if (phase === "partial") {
        ctx.server.broadcast(ctx.handler.formatTranscription(text, false));
        return Promise.resolve({ status: "accepted" });
      }
      if (phase === "commit") {
        if (request.forwardToAgent === true) {

          ctx.server.broadcast(ctx.handler.formatListenCommitted(text, "endpoint", sessionKey));
          dropPendingCommitPublish(sessionKey);
          return Promise.resolve({ status: "accepted" });
        }
        if (request.awaitAppSend === true) {

          ctx.server.broadcast(ctx.handler.formatListenCommitted(text, "endpoint", sessionKey));
          dropPendingCommitPublish(sessionKey);
          armScriptedAppSend(sessionKey, text, request.runId);
          return Promise.resolve({ status: "accepted" });
        }
        ctx.server.broadcast(
          ctx.handler.formatListenCommitted(text, "endpoint", request.sessionKey || null),
        );

        const voiceSendId = simulatedCommitMetadata(request.id, null, "voice").id;
        const publishCommittedUserMessage = () => {
          conversationState.addMessage(
            "user",
            buildLocalUserMessageContent(text, null),
            null,
            { clientSendId: voiceSendId },
          );
          emitDebug(
            "openclaw.message",
            "user_message",
            "info",
            { sessionKey },
            () => ({ text }),
          );
          broadcastPages();
        };
        const pendingCommitEntry = {

          timer: JSON.parse("null"),
          publish: publishCommittedUserMessage,
        };
        pendingCommitEntry.timer = scheduleSyntheticTimer(
          SIMULATE_VOICE_COMMIT_DISPLAY_GATE_MS,
          () => {

            if (pendingCommitPublishBySession.get(sessionKey) === pendingCommitEntry) {
              pendingCommitPublishBySession.delete(sessionKey);
            }
            publishCommittedUserMessage();
          },
          sessionKey,
        );
        pendingCommitPublishBySession.set(sessionKey, pendingCommitEntry);
        return Promise.resolve({ status: "accepted" });
      }
      ctx.server.broadcast(ctx.handler.formatListenEnded());
      return Promise.resolve({ status: "accepted" });
    },
  };

  return {
    handlers,
    clearSyntheticWorkForSession,
    clearSyntheticWork,
    maybeAbsorbScriptedAppSend,
    resolveSyntheticApproval,

    isSyntheticApproval: (approvalId         ) => syntheticApprovals.has(approvalId),

    isVoiceScriptingArmed: () => voiceScriptingArmed,
  };
}

module.exports = { createRelaySimulation };
