const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");

function formatSonioxModels(payload) {
  return JSON.stringify({
    type: APP_PROTOCOL.sonioxModelsSnapshot,
    models: Array.isArray(payload && payload.models) ? payload.models : [],
    fetchedAtMs:
      Number.isFinite(payload && payload.fetchedAtMs)
        ? Math.floor(payload.fetchedAtMs)
        : 0,
    stale: !!(payload && payload.stale),
  });
}

function formatHermesSttTranscribeResult(payload      = {}) {
  const success = !!(payload && payload.success === true);
  const frame      = {
    type: APP_PROTOCOL.hermesSttTranscribeResult,
    requestId:
      payload && typeof payload.requestId === "string" && payload.requestId
        ? payload.requestId
        : null,
    success,
    provider:
      payload && typeof payload.provider === "string" && payload.provider
        ? payload.provider
        : null,
  };
  if (success) {
    frame.transcript =
      payload && typeof payload.transcript === "string"
        ? payload.transcript
        : "";
    return JSON.stringify(frame);
  }
  const error = payload && payload.error ? payload.error : {};
  frame.error = {
    code:
      typeof error.code === "string" && error.code
        ? error.code
        : "link_rpc_failed",
    message:
      typeof error.message === "string" && error.message
        ? error.message
        : "transcription failed",
  };
  return JSON.stringify(frame);
}

function formatTranscription(text, isFinal) {
  return JSON.stringify({
    type: "transcription",
    text,
    final: !!isFinal,
  });
}

function formatListenCommitted(text, source, sessionKey) {
  return JSON.stringify({
    type: "listen-committed",
    text,
    source,
    sessionKey: sessionKey || null,
  });
}

function formatEvenAiListenIntercepted(sessionKey) {
  return JSON.stringify({
    type: "even-ai-listen-intercepted",
    sessionKey: sessionKey ?? null,
  });
}

function formatListenEnded() {
  return JSON.stringify({ type: "listen-ended" });
}

function formatListenError(error, code = null) {
  const msg = { type: "listen-error", error };
  if (typeof code === "string" && code.trim()) {
    msg.code = code.trim();
  }
  return JSON.stringify(msg);
}

function formatListenReady() {
  return JSON.stringify({ type: "listen-ready" });
}

function formatScriptedListenReady(sessionKey = null) {
  return JSON.stringify({
    type: "scripted-listen-ready",
    sessionKey: sessionKey || null,
  });
}

function formatSonioxTemporaryKey(payload) {
  return JSON.stringify({
    type: APP_PROTOCOL.sonioxTemporaryKey,
    voiceSessionId:
      payload && typeof payload.voiceSessionId === "string"
        ? payload.voiceSessionId
        : "",
    temporaryKey:
      payload && typeof payload.temporaryKey === "string"
        ? payload.temporaryKey
        : "",
    expiresAtMs:
      payload && Number.isFinite(payload.expiresAtMs)
        ? Math.floor(payload.expiresAtMs)
        : 0,
  });
}

function formatSonioxTemporaryKeyError(payload) {
  const msg = {
    type: APP_PROTOCOL.sonioxTemporaryKeyError,
    voiceSessionId:
      payload && typeof payload.voiceSessionId === "string"
        ? payload.voiceSessionId
        : "",
    error:
      payload && typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : "Soniox temporary-key request failed",
  };
  const code =
    payload && typeof payload.code === "string" && payload.code.trim()
      ? payload.code.trim()
      : "";
  if (code) {
    msg.code = code;
  }
  return JSON.stringify(msg);
}

function formatCartesiaAccessToken(payload) {
  return JSON.stringify({
    type: APP_PROTOCOL.cartesiaAccessToken,
    voiceSessionId:
      payload && typeof payload.voiceSessionId === "string" ? payload.voiceSessionId : "",
    accessToken:
      payload && typeof payload.accessToken === "string" ? payload.accessToken : "",
    expiresAtMs:
      payload && Number.isFinite(payload.expiresAtMs) ? Math.floor(payload.expiresAtMs) : 0,
  });
}

function formatCartesiaAccessTokenError(payload) {
  const msg = {
    type: APP_PROTOCOL.cartesiaAccessTokenError,
    voiceSessionId:
      payload && typeof payload.voiceSessionId === "string" ? payload.voiceSessionId : "",
    error:
      payload && typeof payload.error === "string" && payload.error.trim()
        ? payload.error.trim()
        : "Cartesia access-token request failed",
  };
  const code =
    payload && typeof payload.code === "string" && payload.code.trim()
      ? payload.code.trim()
      : "";
  if (code) {
    msg.code = code;
  }
  return JSON.stringify(msg);
}

function createHermesSttCapabilitiesFormatter({ hermesSttUpload }     ) {

  function formatHermesSttCapabilities(payload      = {}) {
    const status =
      payload && typeof payload.status === "string" && payload.status
        ? payload.status
        : "offline";
    const frame      = {
      type: APP_PROTOCOL.hermesSttCapabilitiesSnapshot,
      requestId:
        payload && typeof payload.requestId === "string" && payload.requestId
          ? payload.requestId
          : null,
      status,

      providers:
        payload && Array.isArray(payload.providers) ? payload.providers : [],
    };
    if (status === "ok" && payload.uploadProtocolVersion === 1 && hermesSttUpload) {
      frame.uploadProtocolVersion = 1;
    }

    if (status === "ok" && payload.streamProtocolVersion === 1 && hermesSttUpload) {
      frame.streamProtocolVersion = 1;
    }
    if (status === "error") {
      const error = payload && payload.error ? payload.error : {};
      frame.error = {
        code:
          typeof error.code === "string" && error.code
            ? error.code
            : "link_rpc_failed",
        message:
          typeof error.message === "string" && error.message
            ? error.message
            : "stt capability listing failed",
      };
    }
    return JSON.stringify(frame);
  }

  return { formatHermesSttCapabilities };
}

module.exports = { formatSonioxModels, formatHermesSttTranscribeResult, formatTranscription, formatListenCommitted, formatEvenAiListenIntercepted, formatListenEnded, formatListenError, formatListenReady, formatScriptedListenReady, formatSonioxTemporaryKey, formatSonioxTemporaryKeyError, formatCartesiaAccessToken, formatCartesiaAccessTokenError, createHermesSttCapabilitiesFormatter };
