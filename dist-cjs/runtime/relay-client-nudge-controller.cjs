const { APP_PROTOCOL, DEFAULT_NUDGE_THRESHOLDS, } = require("./relay-worker-protocol.cjs");

const RENDER_NUDGE_FRAME = JSON.stringify({ type: "render_nudge" });

function normalizePositiveInteger(value, fallback) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function parseOptionalTrimmedString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function isStreamingBroadcastType(messageType) {
  return (
    messageType === "streaming" ||
    messageType === "ocuclaw.message.stream.delta"
  );
}

function isPagesBroadcastType(messageType) {
  return messageType === "pages" || messageType === APP_PROTOCOL.pages;
}

function isActivityBroadcastType(messageType) {
  return messageType === "activity" || messageType === "ocuclaw.activity.update";
}

function isListenCommittedBroadcastType(messageType) {
  return messageType === "listen-committed";
}

function isListenEndedBroadcastType(messageType) {
  return messageType === "listen-ended";
}

function createRelayClientNudgeController(options = {}) {
  const sendFrame =
    typeof options.sendFrame === "function" ? options.sendFrame : () => {};
  const isAppClient =
    typeof options.isAppClient === "function" ? options.isAppClient : () => false;
  const now =
    typeof options.now === "function" ? options.now : () => Date.now();
  const sourceThresholds = options.thresholds || {};
  const thresholds = {
    nudgeActiveIntervalMs: normalizePositiveInteger(
      sourceThresholds.nudgeActiveIntervalMs,
      DEFAULT_NUDGE_THRESHOLDS.nudgeActiveIntervalMs,
    ),
    nudgeSlowIntervalMs: normalizePositiveInteger(
      sourceThresholds.nudgeSlowIntervalMs,
      DEFAULT_NUDGE_THRESHOLDS.nudgeSlowIntervalMs,
    ),
    nudgeIdleDeactivateMs: normalizeNonNegativeInteger(
      sourceThresholds.nudgeIdleDeactivateMs,
      DEFAULT_NUDGE_THRESHOLDS.nudgeIdleDeactivateMs,
    ),
    nudgeHeartbeatIntervalMs: normalizePositiveInteger(
      sourceThresholds.nudgeHeartbeatIntervalMs,
      DEFAULT_NUDGE_THRESHOLDS.nudgeHeartbeatIntervalMs,
    ),
    nudgeHardTimeoutMs: normalizePositiveInteger(
      sourceThresholds.nudgeHardTimeoutMs,
      DEFAULT_NUDGE_THRESHOLDS.nudgeHardTimeoutMs,
    ),
  };
  const nudgeStaleHeartbeatThresholdMs = thresholds.nudgeHeartbeatIntervalMs * 2;
  const clientNudgeState = new Map();

  function interactionStageBucket(stage) {
    switch (stage) {
      case "listening":
      case "voice_handoff":
      case "thinking":
        return "active_non_stream";
      case "streaming":
      case "post_turn_drain":
        return "active_stream";
      default:
        return "idle";
    }
  }

  function createClientState() {
    return {
      visibilityState: null,
      streamChars: null,
      lastHeartbeatAtMs: null,
      lastRelayStreamingActivityAtMs: null,
      interactionStage: "idle",
      cadenceBucket: "idle",
      nudgeActive: false,
      nudgeIntervalMs: null,
      nudgeStartedAtMs: null,
      lastNudgeAtMs: null,
      stalledHeartbeatCount: 0,
      nudgeTimer: null,
      idleDeactivateTimer: null,
      staleHeartbeatTimer: null,
      hardTimeoutTimer: null,
    };
  }

  function cloneClientState(state) {
    if (!state) return null;
    return {
      visibilityState: state.visibilityState || null,
      streamChars: Number.isFinite(state.streamChars) ? state.streamChars : null,
      lastHeartbeatAtMs: Number.isFinite(state.lastHeartbeatAtMs)
        ? state.lastHeartbeatAtMs
        : null,
      lastRelayStreamingActivityAtMs: Number.isFinite(
        state.lastRelayStreamingActivityAtMs,
      )
        ? state.lastRelayStreamingActivityAtMs
        : null,
      interactionStage: state.interactionStage || "idle",
      cadenceBucket: state.cadenceBucket || "idle",
      nudgeActive: !!state.nudgeActive,
      nudgeIntervalMs: Number.isFinite(state.nudgeIntervalMs)
        ? state.nudgeIntervalMs
        : null,
      nudgeStartedAtMs: Number.isFinite(state.nudgeStartedAtMs)
        ? state.nudgeStartedAtMs
        : null,
      lastNudgeAtMs: Number.isFinite(state.lastNudgeAtMs)
        ? state.lastNudgeAtMs
        : null,
      stalledHeartbeatCount: Number.isFinite(state.stalledHeartbeatCount)
        ? state.stalledHeartbeatCount
        : 0,
    };
  }

  function ensureClientState(clientId) {
    let state = clientNudgeState.get(clientId);
    if (!state) {
      state = createClientState();
      clientNudgeState.set(clientId, state);
    }
    return state;
  }

  function addClient(clientId) {
    ensureClientState(clientId);
  }

  function clearClientNudgeTimer(state, key, clearFn = clearTimeout) {
    if (!state || !state[key]) return;
    clearFn(state[key]);
    state[key] = null;
  }

  function clearClientTimers(clientId) {
    const state = clientNudgeState.get(clientId);
    if (!state) return;
    clearClientNudgeTimer(state, "nudgeTimer", clearInterval);
    clearClientNudgeTimer(state, "idleDeactivateTimer");
    clearClientNudgeTimer(state, "staleHeartbeatTimer");
    clearClientNudgeTimer(state, "hardTimeoutTimer");
  }

  function resetClientStallTracking(state) {
    if (!state) return;
    state.stalledHeartbeatCount = 0;
  }

  function hasStaleHeartbeat(state, observedAtMs = now()) {
    if (!state || !Number.isFinite(state.lastHeartbeatAtMs)) {
      return false;
    }
    return observedAtMs - state.lastHeartbeatAtMs >= nudgeStaleHeartbeatThresholdMs;
  }

  function isVisibilityDegraded(state) {
    return (
      !!state &&
      (state.visibilityState === "hidden" || state.visibilityState === "blurred")
    );
  }

  function sendRenderNudge(clientId) {
    if (!isAppClient(clientId)) {
      stopClientNudges(clientId, "socket_unavailable");
      return;
    }
    const result = sendFrame(clientId, RENDER_NUDGE_FRAME);
    if (result === false) {
      stopClientNudges(clientId, "socket_unavailable");
      return;
    }
    ensureClientState(clientId).lastNudgeAtMs = now();
  }

  function scheduleClientHardTimeout(clientId) {
    const state = clientNudgeState.get(clientId);
    if (!state) return;
    clearClientNudgeTimer(state, "hardTimeoutTimer");
    if (!state.nudgeActive) return;
    state.hardTimeoutTimer = setTimeout(() => {
      state.hardTimeoutTimer = null;
      setInteractionStage(clientId, "idle", {
        reason: "nudge_hard_timeout",
        deactivateImmediately: true,
      });
    }, thresholds.nudgeHardTimeoutMs);
  }

  function startClientNudges(
    clientId,
    intervalMs,
    reason = "nudge_start",
    sendImmediately = false,
  ) {
    if (!isAppClient(clientId)) return;
    const state = ensureClientState(clientId);
    const nextIntervalMs = Math.max(1, Math.floor(intervalMs));
    const wasActive = !!state.nudgeActive;
    const intervalChanged = state.nudgeIntervalMs !== nextIntervalMs;
    state.cadenceBucket = interactionStageBucket(state.interactionStage);
    if (!wasActive) {
      state.nudgeActive = true;
      state.nudgeStartedAtMs = now();
    }
    if (wasActive && !intervalChanged) {
      return;
    }
    clearClientNudgeTimer(state, "nudgeTimer", clearInterval);
    state.nudgeActive = true;
    state.nudgeIntervalMs = nextIntervalMs;
    state.nudgeTimer = setInterval(() => {
      sendRenderNudge(clientId);
    }, nextIntervalMs);
    if (!wasActive) {
      scheduleClientHardTimeout(clientId);
      if (sendImmediately) {
        sendRenderNudge(clientId);
      }
    }
  }

  function stopClientNudges(clientId, _reason = "nudge_stop") {
    const state = clientNudgeState.get(clientId);
    if (!state) return;
    clearClientNudgeTimer(state, "nudgeTimer", clearInterval);
    clearClientNudgeTimer(state, "idleDeactivateTimer");
    clearClientNudgeTimer(state, "hardTimeoutTimer");
    state.nudgeActive = false;
    state.nudgeIntervalMs = null;
    state.nudgeStartedAtMs = null;
    resetClientStallTracking(state);
    scheduleClientStaleHeartbeatCheck(clientId);
  }

  function scheduleClientIdleDeactivation(clientId) {
    const state = clientNudgeState.get(clientId);
    if (!state) return;
    clearClientNudgeTimer(state, "idleDeactivateTimer");
    if (!state.nudgeActive || state.interactionStage !== "idle") {
      return;
    }
    state.idleDeactivateTimer = setTimeout(() => {
      state.idleDeactivateTimer = null;
      const currentState = clientNudgeState.get(clientId);
      if (!currentState || currentState.interactionStage !== "idle") {
        return;
      }
      stopClientNudges(clientId, "idle_grace_elapsed");
    }, thresholds.nudgeIdleDeactivateMs);
  }

  function scheduleClientStaleHeartbeatCheck(clientId) {
    const state = clientNudgeState.get(clientId);
    if (!state) return;
    clearClientNudgeTimer(state, "staleHeartbeatTimer");
    if (
      state.nudgeActive ||
      interactionStageBucket(state.interactionStage) === "idle" ||
      !Number.isFinite(state.lastHeartbeatAtMs)
    ) {
      return;
    }
    const delayMs = Math.max(
      0,
      (state.lastHeartbeatAtMs + nudgeStaleHeartbeatThresholdMs) - now(),
    );
    state.staleHeartbeatTimer = setTimeout(() => {
      state.staleHeartbeatTimer = null;
      const currentState = clientNudgeState.get(clientId);
      if (
        !currentState ||
        currentState.nudgeActive ||
        interactionStageBucket(currentState.interactionStage) === "idle"
      ) {
        return;
      }
      if (!hasStaleHeartbeat(currentState)) {
        scheduleClientStaleHeartbeatCheck(clientId);
        return;
      }
      startClientNudges(
        clientId,
        thresholds.nudgeActiveIntervalMs,
        "stale_heartbeat_fallback",
        true,
      );
    }, delayMs);
  }

  function maybeActivateClientNudges(clientId, reason = "nudge_eval") {
    const state = clientNudgeState.get(clientId);
    if (!state || !isAppClient(clientId)) return;
    state.cadenceBucket = interactionStageBucket(state.interactionStage);
    if (state.cadenceBucket === "idle") {
      clearClientNudgeTimer(state, "staleHeartbeatTimer");
      return;
    }
    if (state.nudgeActive) {
      return;
    }
    if (isVisibilityDegraded(state) || hasStaleHeartbeat(state)) {
      startClientNudges(clientId, thresholds.nudgeActiveIntervalMs, reason, true);
      return;
    }
    scheduleClientStaleHeartbeatCheck(clientId);
  }

  function setInteractionStage(clientId, nextStage, options = {}) {
    if (!isAppClient(clientId)) return;
    const state = ensureClientState(clientId);
    const reason = options.reason || "interaction_stage";
    const deactivateImmediately = options.deactivateImmediately === true;
    state.interactionStage = nextStage;
    state.cadenceBucket = interactionStageBucket(nextStage);
    if (state.cadenceBucket !== "active_stream") {
      resetClientStallTracking(state);
    }
    if (state.cadenceBucket === "idle") {
      clearClientNudgeTimer(state, "staleHeartbeatTimer");
      if (deactivateImmediately) {
        stopClientNudges(clientId, reason);
      } else {
        scheduleClientIdleDeactivation(clientId);
      }
      return;
    }
    clearClientNudgeTimer(state, "idleDeactivateTimer");
    if (
      state.cadenceBucket === "active_non_stream" &&
      state.nudgeActive &&
      state.nudgeIntervalMs !== thresholds.nudgeActiveIntervalMs
    ) {
      startClientNudges(clientId, thresholds.nudgeActiveIntervalMs, reason, false);
    }
    maybeActivateClientNudges(clientId, reason);
  }

  function observeRelayStreamingActivity(clientId, atMs) {
    if (!isAppClient(clientId)) return;
    const state = ensureClientState(clientId);
    state.lastRelayStreamingActivityAtMs = atMs;
    resetClientStallTracking(state);
    if (
      state.nudgeActive &&
      state.nudgeIntervalMs !== thresholds.nudgeActiveIntervalMs
    ) {
      startClientNudges(
        clientId,
        thresholds.nudgeActiveIntervalMs,
        "relay_stream_progress",
      );
      return;
    }
    maybeActivateClientNudges(clientId, "relay_stream_activity");
  }

  function updateHeartbeat(clientId, ping) {
    const state = ensureClientState(clientId);
    const previousHeartbeatAtMs = Number.isFinite(state.lastHeartbeatAtMs)
      ? state.lastHeartbeatAtMs
      : null;
    const previousStreamChars = Number.isFinite(state.streamChars)
      ? state.streamChars
      : null;
    const nextStreamChars = Number.isFinite(ping.streamChars) ? ping.streamChars : null;
    const streamAdvanced =
      nextStreamChars !== null &&
      (previousStreamChars === null || nextStreamChars > previousStreamChars);
    const relayStreamAdvanced =
      previousHeartbeatAtMs !== null &&
      Number.isFinite(state.lastRelayStreamingActivityAtMs) &&
      state.lastRelayStreamingActivityAtMs > previousHeartbeatAtMs;
    state.streamChars = nextStreamChars;
    if (ping.visibilityState) {
      state.visibilityState = ping.visibilityState;
    }
    state.lastHeartbeatAtMs = now();
    state.cadenceBucket = interactionStageBucket(state.interactionStage);
    if (state.visibilityState === "visible") {
      stopClientNudges(clientId, "heartbeat_visible");
    }
    if (state.cadenceBucket === "active_stream") {
      if (streamAdvanced || relayStreamAdvanced) {
        resetClientStallTracking(state);
        if (
          state.nudgeActive &&
          state.nudgeIntervalMs !== thresholds.nudgeActiveIntervalMs
        ) {
          startClientNudges(
            clientId,
            thresholds.nudgeActiveIntervalMs,
            streamAdvanced
              ? "heartbeat_stream_progress"
              : "relay_stream_progress",
            false,
          );
        }
      } else if (state.nudgeActive) {
        state.stalledHeartbeatCount += 1;
        if (
          state.stalledHeartbeatCount >= 3 &&
          state.nudgeIntervalMs !== thresholds.nudgeSlowIntervalMs
        ) {
          startClientNudges(
            clientId,
            thresholds.nudgeSlowIntervalMs,
            "stream_stalled_decelerated",
            false,
          );
        }
      }
    } else {
      resetClientStallTracking(state);
      if (
        state.nudgeActive &&
        state.nudgeIntervalMs !== thresholds.nudgeActiveIntervalMs
      ) {
        startClientNudges(
          clientId,
          thresholds.nudgeActiveIntervalMs,
          "non_stream_fast",
          false,
        );
      }
    }
    maybeActivateClientNudges(clientId, "heartbeat_update");
  }

  function updateVisibilityState(clientId, visibilityState) {
    const state = ensureClientState(clientId);
    state.visibilityState = visibilityState;
    if (visibilityState === "visible") {
      stopClientNudges(clientId, "visibility_visible");
      return;
    }
    maybeActivateClientNudges(clientId, "visibility_hidden");
  }

  function applyBroadcastInteractionStage(messageType, parsed, relayStreamingActivityAtMs) {
    for (const [clientId] of clientNudgeState) {
      if (!isAppClient(clientId)) {
        continue;
      }
      if (relayStreamingActivityAtMs !== null) {
        setInteractionStage(clientId, "streaming", {
          reason: "relay_streaming",
        });
        observeRelayStreamingActivity(clientId, relayStreamingActivityAtMs);
        continue;
      }
      if (isListenCommittedBroadcastType(messageType)) {
        setInteractionStage(clientId, "voice_handoff", {
          reason: "listen_committed",
        });
        continue;
      }
      if (isListenEndedBroadcastType(messageType)) {
        setInteractionStage(clientId, "idle", {
          reason: "listen_ended",
          deactivateImmediately: true,
        });
        continue;
      }
      if (isActivityBroadcastType(messageType)) {
        const activityState = parseOptionalTrimmedString(parsed && parsed.state);
        const normalizedActivity = activityState ? activityState.toLowerCase() : null;
        const currentStage = ensureClientState(clientId).interactionStage;
        if (normalizedActivity === "thinking") {
          setInteractionStage(clientId, "thinking", {
            reason: "activity_thinking",
          });
        } else if (normalizedActivity === "idle") {
          if (currentStage === "streaming" || currentStage === "post_turn_drain") {
            setInteractionStage(clientId, "post_turn_drain", {
              reason: "activity_idle_stream_drain",
            });
          } else {
            setInteractionStage(clientId, "idle", {
              reason: "activity_idle",
            });
          }
        }
        continue;
      }
      if (isPagesBroadcastType(messageType)) {
        const currentState = ensureClientState(clientId);
        if (interactionStageBucket(currentState.interactionStage) !== "idle") {
          setInteractionStage(clientId, "post_turn_drain", {
            reason: "pages_snapshot",
          });
        }
      }
    }
  }

  function getClientState(clientId) {
    return cloneClientState(clientNudgeState.get(clientId) || null);
  }

  function deleteClient(clientId) {
    clearClientTimers(clientId);
    clientNudgeState.delete(clientId);
  }

  function clear() {
    for (const [clientId] of clientNudgeState) {
      clearClientTimers(clientId);
    }
    clientNudgeState.clear();
  }

  return {
    createClientState,
    cloneClientState,
    addClient,
    clearClientTimers,
    updateVisibilityState,
    updateHeartbeat,
    setInteractionStage,
    applyBroadcastInteractionStage,
    getClientState,
    deleteClient,
    clear,
  };
}

module.exports = { createRelayClientNudgeController };
