const { parseOptionalTrimmedString, parseOptionalBoolean, parseOptionalPositiveNumber, parseOptionalNonNegativeNumber, parseOptionalStringArray } = require("./downstream-parse-optional.cjs");

function normalizeRemoteButton(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("remote-control button is required");
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "click" ||
    normalized === "tap" ||
    normalized === "double-click" ||
    normalized === "double_click" ||
    normalized === "doubleclick" ||
    normalized === "double-tap" ||
    normalized === "double_tap" ||
    normalized === "doubletap" ||

    normalized === "double-click-left" ||
    normalized === "double_click_left" ||
    normalized === "doubleclickleft" ||
    normalized === "double-tap-left" ||
    normalized === "double_tap_left" ||
    normalized === "doubletapleft" ||
    normalized === "double-click-right" ||
    normalized === "double_click_right" ||
    normalized === "doubleclickright" ||
    normalized === "double-tap-right" ||
    normalized === "double_tap_right" ||
    normalized === "doubletapright" ||
    normalized === "long-press" ||
    normalized === "long_press" ||
    normalized === "longpress" ||
    normalized === "long-press-release" ||
    normalized === "long_press_release" ||
    normalized === "longpressrelease" ||
    normalized === "scroll-up" ||
    normalized === "scroll_up" ||
    normalized === "scrollup" ||
    normalized === "up" ||
    normalized === "scroll-down" ||
    normalized === "scroll_down" ||
    normalized === "scrolldown" ||
    normalized === "down"
  ) {
    if (normalized === "tap") return "click";
    if (
      normalized === "double_click" ||
      normalized === "doubleclick" ||
      normalized === "double-tap" ||
      normalized === "double_tap" ||
      normalized === "doubletap"
    ) {
      return "double-click";
    }
    if (
      normalized === "double_click_left" ||
      normalized === "doubleclickleft" ||
      normalized === "double-tap-left" ||
      normalized === "double_tap_left" ||
      normalized === "doubletapleft"
    ) {
      return "double-click-left";
    }
    if (
      normalized === "double_click_right" ||
      normalized === "doubleclickright" ||
      normalized === "double-tap-right" ||
      normalized === "double_tap_right" ||
      normalized === "doubletapright"
    ) {
      return "double-click-right";
    }
    if (normalized === "long_press" || normalized === "longpress") {
      return "long-press";
    }
    if (
      normalized === "long_press_release" ||
      normalized === "longpressrelease"
    ) {
      return "long-press-release";
    }
    if (normalized === "scroll_up" || normalized === "scrollup" || normalized === "up") {
      return "scroll-up";
    }
    if (normalized === "scroll_down" || normalized === "scrolldown" || normalized === "down") {
      return "scroll-down";
    }
    return normalized;
  }
  throw new Error(`unsupported remote-control button: ${raw}`);
}

function normalizeRemoteRelayAction(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("remote-control relayAction is required");
  }
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "perf-conversation-upgrade-probe" ||
    normalized === "perf_conversation_upgrade_probe" ||
    normalized === "perfconversationupgradeprobe" ||
    normalized === "conversation-upgrade-probe" ||
    normalized === "conversation_upgrade_probe" ||
    normalized === "conversationupgradeprobe"
  ) {
    return "perf-conversation-upgrade-probe";
  }
  if (
    normalized === "new-session" ||
    normalized === "new_session" ||
    normalized === "newsession"
  ) {
    return "new-session";
  }
  if (
    normalized === "get-sessions" ||
    normalized === "get_sessions" ||
    normalized === "getsessions" ||
    normalized === "sessions"
  ) {
    return "get-sessions";
  }
  if (
    normalized === "switch-session" ||
    normalized === "switch_session" ||
    normalized === "switchsession"
  ) {
    return "switch-session";
  }
  if (normalized === "new-chat" || normalized === "new_chat" || normalized === "newchat") {
    return "new-chat";
  }
  if (
    normalized === "slash-command" ||
    normalized === "slash_command" ||
    normalized === "slash"
  ) {
    return "slash-command";
  }
  if (
    normalized === "listen-start" ||
    normalized === "listen_start" ||
    normalized === "listenstart"
  ) {
    return "listen-start";
  }
  if (
    normalized === "listen-stop" ||
    normalized === "listen_stop" ||
    normalized === "listenstop"
  ) {
    return "listen-stop";
  }
  if (
    normalized === "listen-send" ||
    normalized === "listen_send" ||
    normalized === "listensend"
  ) {
    return "listen-send";
  }
  if (
    normalized === "listen-retry" ||
    normalized === "listen_retry" ||
    normalized === "listenretry"
  ) {
    return "listen-retry";
  }
  if (
    normalized === "ptt-confirm" ||
    normalized === "ptt_confirm" ||
    normalized === "pttconfirm"
  ) {
    return "ptt-confirm";
  }
  if (
    normalized === "ptt-redo" ||
    normalized === "ptt_redo" ||
    normalized === "pttredo"
  ) {
    return "ptt-redo";
  }
  if (
    normalized === "ptt-cancel" ||
    normalized === "ptt_cancel" ||
    normalized === "pttcancel"
  ) {
    return "ptt-cancel";
  }
  if (
    normalized === "ptt-partial" ||
    normalized === "ptt_partial" ||
    normalized === "pttpartial"
  ) {
    return "ptt-partial";
  }
  if (normalized === "ptt-lab-confirmed-partial") {
    return "ptt-lab-confirmed-partial";
  }
  if (["ptt-lab-hermes-start", "ptt-lab-pcm", "voice-lab-endpoint"].includes(normalized)) return normalized;

  if (normalized === "imu-lab" || normalized === "imu_lab") return "imu-lab";
  const tapLabAction = normalized.replace(/_/g, "-");
  if (["ptt-lab-tap-start", "ptt-lab-tap-stop", "ptt-lab-endpoint", "ptt-lab-final"].includes(tapLabAction)) return tapLabAction;
  if (
    normalized === "ptt-lab-start" ||
    normalized === "ptt_lab_start" ||
    normalized === "pttlabstart"
  ) {
    return "ptt-lab-start";
  }
  if (
    normalized === "ptt-lab-commit" ||
    normalized === "ptt_lab_commit" ||
    normalized === "pttlabcommit"
  ) {
    return "ptt-lab-commit";
  }
  if (
    normalized === "ptt-lab-release" ||
    normalized === "ptt_lab_release" ||
    normalized === "pttlabrelease"
  ) {
    return "ptt-lab-release";
  }
  if (
    normalized === "perf-reset-ladder" ||
    normalized === "perf_reset_ladder" ||
    normalized === "perfresetladder" ||
    normalized === "reset-ladder" ||
    normalized === "reset_ladder" ||
    normalized === "resetladder"
  ) {
    return "perf-reset-ladder";
  }
  if (
    normalized === "perf-relay-reconnect-only" ||
    normalized === "perf_relay_reconnect_only" ||
    normalized === "perfrelayreconnectonly" ||
    normalized === "relay-reconnect-only" ||
    normalized === "relay_reconnect_only" ||
    normalized === "relayreconnectonly"
  ) {
    return "perf-relay-reconnect-only";
  }
  if (
    normalized === "perf-sdk-page-recreate-only" ||
    normalized === "perf_sdk_page_recreate_only" ||
    normalized === "perfsdkpagerecreateonly" ||
    normalized === "sdk-page-recreate-only" ||
    normalized === "sdk_page_recreate_only" ||
    normalized === "sdkpagerecreateonly"
  ) {
    return "perf-sdk-page-recreate-only";
  }
  if (
    normalized === "perf-config" ||
    normalized === "perf_config" ||
    normalized === "perfconfig" ||
    normalized === "perf-drift-config" ||
    normalized === "perf_drift_config" ||
    normalized === "perfdriftconfig"
  ) {
    return "perf-config";
  }
  if (
    normalized === "waveform-demo" ||
    normalized === "waveform_demo" ||
    normalized === "waveformdemo"
  ) {
    return "waveform-demo";
  }
  if (
    normalized === "debug-close-app-client" ||
    normalized === "debug_close_app_client" ||
    normalized === "debugcloseappclient" ||
    normalized === "close-app-client" ||
    normalized === "close_app_client" ||
    normalized === "closeappclient"
  ) {
    return "debug-close-app-client";
  }
  throw new Error(`unsupported remote relayAction: ${raw}`);
}

const HEAD_MAX_DEGREES = 90;

function parseHeadDegrees(raw         , fieldName        )                     {
  if (raw === undefined || raw === null) return undefined;
  const isText = typeof raw === "string" && raw.trim() !== "";
  const degrees = typeof raw === "number" || isText ? Number(raw) : NaN;
  if (!Number.isFinite(degrees)) {
    throw new Error(`remote-control head-pose ${fieldName} must be a finite number of degrees`);
  }
  const clamped = Math.max(-HEAD_MAX_DEGREES, Math.min(HEAD_MAX_DEGREES, degrees));

  return Math.round(clamped * 100) / 100;
}

const REMOTE_BUTTON_SOURCES = ["left", "right", "ring"];

const SOURCED_BUTTONS = ["click", "double-click", "long-press", "long-press-release"];

function normalizeRemoteButtonSource(raw         , button        )                     {
  if (raw === undefined || raw === null) return undefined;
  const source = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!REMOTE_BUTTON_SOURCES.includes(source)) {
    throw new Error(`remote-control button source must be left, right or ring, got: ${String(raw)}`);
  }
  if (button === "double-click-left" || button === "double-click-right") {
    throw new Error(`remote-control ${button} already names its temple; send double-click with source instead`);
  }
  if (!SOURCED_BUTTONS.includes(button)) {
    throw new Error(`remote-control button ${button} takes no source (only ${SOURCED_BUTTONS.join(", ")})`);
  }
  return source;
}

const GLASSES_ACTIONS                           = {
  "button"(msg, payload) {
    const button = normalizeRemoteButton(msg.button);
    payload.button = button;
    const source = normalizeRemoteButtonSource(msg.source, button);
    if (source) payload.source = source;
    return payload;
  },

  "relay-action"(msg, payload) {
    const normalizedRelayAction = normalizeRemoteRelayAction(msg.relayAction);
    payload.relayAction = normalizedRelayAction;
    if (
      normalizedRelayAction === "listen-start" ||
      normalizedRelayAction === "listen-stop" ||
      normalizedRelayAction === "listen-send" ||
      normalizedRelayAction === "listen-retry"
    ) {
      throw new Error(
        `remote-control relayAction ${normalizedRelayAction} was removed; voice stays local to the app`,
      );
    }
    const sessionKey = parseOptionalTrimmedString(msg.sessionKey);
    const command = parseOptionalTrimmedString(msg.command);
    if (normalizedRelayAction === "switch-session" && !sessionKey) {
      throw new Error("remote-control switch-session requires sessionKey");
    }
    if (normalizedRelayAction === "slash-command" && !command) {
      throw new Error("remote-control slash-command requires command");
    }
    if (
      (normalizedRelayAction === "ptt-partial" || normalizedRelayAction === "ptt-lab-confirmed-partial" || normalizedRelayAction === "ptt-lab-commit" || normalizedRelayAction === "imu-lab") &&
      !command
    ) {
      throw new Error(`remote-control ${normalizedRelayAction} requires command`);
    }
    if (sessionKey) payload.sessionKey = sessionKey;

    const explicitLabFinal = ["ptt-lab-tap-stop", "ptt-lab-endpoint", "ptt-lab-final"].includes(normalizedRelayAction) &&
      typeof msg.command === "string";
    if (command || explicitLabFinal) payload.command = command || "";
    const endpointDetection = parseOptionalBoolean(msg.endpointDetection, "endpointDetection");
    if (endpointDetection !== undefined) payload.endpointDetection = endpointDetection;
    const maxEndpointDelayMs = parseOptionalPositiveNumber(
      msg.maxEndpointDelayMs,
      "maxEndpointDelayMs",
    );
    if (maxEndpointDelayMs !== undefined) payload.maxEndpointDelayMs = maxEndpointDelayMs;
    const model = parseOptionalTrimmedString(msg.model);
    if (model) payload.model = model;
    const languageHints = parseOptionalStringArray(msg.languageHints, "languageHints");
    if (languageHints !== undefined) payload.languageHints = languageHints;
    return payload;
  },

  "list-click"(msg, payload) {
    const index = parseOptionalNonNegativeNumber(msg.index, "index");
    if (index === undefined) {
      throw new Error("remote-control list-click requires index");
    }
    payload.index = index;
    const containerId = parseOptionalNonNegativeNumber(msg.containerId, "containerId");
    const containerName = parseOptionalTrimmedString(msg.containerName);
    if (containerId !== undefined) payload.containerId = containerId;
    if (containerName) payload.containerName = containerName;
    return payload;
  },

  "menu-item-click"(msg, payload) {
    const itemId = Number(msg.itemId);
    if (!Number.isInteger(itemId) || itemId < 1 || itemId > 0xffff_ffff) {
      throw new Error("remote-control menu-item-click requires itemId to be a non-zero uint32");
    }
    return { ...payload, itemId };
  },

  "text-event"(msg, payload) {
    payload.eventType = normalizeRemoteButton(msg.eventType || msg.button);
    const containerId = parseOptionalNonNegativeNumber(msg.containerId, "containerId");
    const containerName = parseOptionalTrimmedString(msg.containerName);
    if (containerId !== undefined) payload.containerId = containerId;
    if (containerName) payload.containerName = containerName;
    return payload;
  },

  "head-pose"(msg, payload) {
    const pitch = parseHeadDegrees(msg.pitch, "pitch");
    const roll = parseHeadDegrees(msg.roll, "roll");
    if (pitch === undefined && roll === undefined) {
      throw new Error("remote-control head-pose requires pitch or roll");
    }
    payload.value = String(pitch ?? 0);
    payload.text = String(roll ?? 0);
    return payload;
  },
};

module.exports = { GLASSES_ACTIONS };
