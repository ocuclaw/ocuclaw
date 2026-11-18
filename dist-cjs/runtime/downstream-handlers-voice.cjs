const { normalizeSonioxTemporaryKeyErrorCodeForDownstream: normalizeSonioxTemporaryKeyErrorCode } = require("../domain/soniox-temp-key-errors.cjs");
const { parseOptionalTrimmedString } = require("./downstream-parse-optional.cjs");
const { formatSonioxModels, formatHermesSttTranscribeResult, formatSonioxTemporaryKey, formatSonioxTemporaryKeyError, formatCartesiaAccessToken, formatCartesiaAccessTokenError } = require("./downstream-codec-voice.cjs");

function createVoiceHandlers({
  logger,
  formatHermesSttCapabilities,
  onGetSonioxModels,
  onGetHermesSttCapabilities,
  onHermesSttTranscribe,
  onRequestSonioxTemporaryKey,
  onRequestCartesiaAccessToken,
}     ) {
  function parseRequestCartesiaAccessToken(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("requestCartesiaAccessToken payload must be an object");
    }

    const voiceSessionId = parseOptionalTrimmedString(msg.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }

    return {
      voiceSessionId,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey),
    };
  }

  function normalizeCartesiaAccessTokenErrorCode(err) {

    const explicit = err && typeof err.code === "string" ? err.code.trim() : "";
    if (explicit) return explicit;

    const message =
      err && typeof err.message === "string" && err.message.trim()
        ? err.message.trim()
        : "";
    const lowered = message.toLowerCase();
    if (!message) return "cartesia_access_token_failed";

    if (err && err.name === "AbortError") {
      return "cartesia_access_token_mint_timeout";
    }
    if (lowered.includes("api key is not configured")) {
      return "cartesia_access_token_not_configured";
    }
    if (lowered.includes("fetch is not available")) {
      return "cartesia_access_token_fetch_unavailable";
    }
    if (lowered.includes("voicesessionid is required")) {
      return "cartesia_access_token_invalid_request";
    }
    if (lowered.includes("missing token")) {
      return "cartesia_access_token_invalid_response";
    }
    const statusMatch = lowered.match(/\((\d{3})\)/);
    if (statusMatch) {
      return `cartesia_access_token_http_${statusMatch[1]}`;
    }
    return "cartesia_access_token_failed";
  }

  function parseRequestSonioxTemporaryKey(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("requestSonioxTemporaryKey payload must be an object");
    }

    const voiceSessionId = parseOptionalTrimmedString(msg.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }

    return {
      voiceSessionId,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey),
      preparationPurpose: ["foreground", "warm_spare"].includes(msg.preparationPurpose) ? msg.preparationPurpose : "unknown",
    };
  }

  function handleGetSonioxModels(clientId) {
    if (!onGetSonioxModels) {
      return {
        unicast: formatSonioxModels({
          models: [],
          fetchedAtMs: Date.now(),
          stale: true,
        }),
      };
    }
    return Promise.resolve(onGetSonioxModels()).then(
      (payload) => ({
        unicast: formatSonioxModels(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getSonioxModels failed: ${err.message}`);
        return {
          unicast: formatSonioxModels({
            models: [],
            fetchedAtMs: Date.now(),
            stale: true,
          }),
        };
      },
    );
  }

  function handleGetHermesSttCapabilities(msg      = {}) {
    const requestId = parseOptionalTrimmedString(msg && msg.requestId);
    if (!onGetHermesSttCapabilities) {
      return {
        unicast: formatHermesSttCapabilities({
          requestId,
          status: "offline",
          providers: [],
        }),
      };
    }
    return Promise.resolve(onGetHermesSttCapabilities()).then(
      (payload     ) => ({
        unicast: formatHermesSttCapabilities({
          ...(payload || {}),
          requestId,
        }),
      }),
      (err     ) => {
        logger.error(
          `[downstream] hermes stt capabilities failed: ${
            err && err.message ? err.message : err
          }`,
        );
        return {
          unicast: formatHermesSttCapabilities({
            requestId,
            status: "error",
            providers: [],
            error: {
              code: "link_rpc_failed",
              message:
                err && err.message
                  ? String(err.message)
                  : "stt capability listing failed",
            },
          }),
        };
      },
    );
  }

  function handleHermesSttTranscribe(msg      = {}) {
    const requestId = parseOptionalTrimmedString(msg && msg.requestId);
    const provider = parseOptionalTrimmedString(msg && msg.provider);
    if (!onHermesSttTranscribe) {
      return {
        unicast: formatHermesSttTranscribeResult({
          requestId,
          success: false,
          provider,
          error: {
            code: "offline",
            message:
              "no live Hermes link: speech-to-text is unavailable on this host",
          },
        }),
      };
    }

    return Promise.resolve(
      onHermesSttTranscribe({
        provider: msg ? msg.provider : undefined,
        model: msg ? msg.model : undefined,
        language: msg ? msg.language : undefined,
        prompt: msg ? msg.prompt : undefined,
        audio: msg ? msg.audio : undefined,
      }),
    ).then(
      (payload     ) => ({
        unicast: formatHermesSttTranscribeResult({
          provider,
          ...(payload || {}),
          requestId,
        }),
      }),
      (err     ) => {
        logger.error(
          `[downstream] hermes stt transcribe failed: ${
            err && err.message ? err.message : err
          }`,
        );
        return {
          unicast: formatHermesSttTranscribeResult({
            requestId,
            success: false,
            provider,
            error: {
              code: "link_rpc_failed",
              message:
                err && err.message
                  ? String(err.message)
                  : "transcription failed",
            },
          }),
        };
      },
    );
  }

  function handleRequestSonioxTemporaryKey(clientId, msg) {
    let payload;
    try {
      payload = parseRequestSonioxTemporaryKey(msg);
    } catch (err) {
      return {
        unicast: formatSonioxTemporaryKeyError({
          voiceSessionId:
            msg && typeof msg.voiceSessionId === "string" ? msg.voiceSessionId : "",
          error: err && err.message ? err.message : "requestSonioxTemporaryKey failed",
          code: normalizeSonioxTemporaryKeyErrorCode(err),
        }),
      };
    }

    if (!onRequestSonioxTemporaryKey) {
      return {
        unicast: formatSonioxTemporaryKeyError({
          voiceSessionId: payload.voiceSessionId,
          error: "requestSonioxTemporaryKey is not available",
          code: "soniox_temp_key_unavailable",
        }),
      };
    }

    try {
      const result = onRequestSonioxTemporaryKey(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => ({ unicast: formatSonioxTemporaryKey(resolved || payload) }),
          (err) => {
            const error =
              err && err.message
                ? err.message
                : "requestSonioxTemporaryKey failed";
            return {
              unicast: formatSonioxTemporaryKeyError({
                voiceSessionId: payload.voiceSessionId,
                error,
                code: normalizeSonioxTemporaryKeyErrorCode(err),
              }),
            };
          },
        );
      }
      return { unicast: formatSonioxTemporaryKey(result || payload) };
    } catch (err) {
      return {
        unicast: formatSonioxTemporaryKeyError({
          voiceSessionId: payload.voiceSessionId,
          error: err && err.message ? err.message : "requestSonioxTemporaryKey failed",
          code: normalizeSonioxTemporaryKeyErrorCode(err),
        }),
      };
    }
  }

  function handleRequestCartesiaAccessToken(clientId, msg) {
    let payload;
    try {
      payload = parseRequestCartesiaAccessToken(msg);
    } catch (err) {
      return {
        unicast: formatCartesiaAccessTokenError({
          voiceSessionId:
            msg && typeof msg.voiceSessionId === "string" ? msg.voiceSessionId : "",
          error: err && err.message ? err.message : "requestCartesiaAccessToken failed",
          code: normalizeCartesiaAccessTokenErrorCode(err),
        }),
      };
    }

    if (!onRequestCartesiaAccessToken) {
      return {
        unicast: formatCartesiaAccessTokenError({
          voiceSessionId: payload.voiceSessionId,
          error: "requestCartesiaAccessToken is not available",
          code: "cartesia_access_token_unavailable",
        }),
      };
    }

    try {
      const result = onRequestCartesiaAccessToken(clientId, payload);
      if (result && typeof result.then === "function") {
        return result.then(
          (resolved) => ({ unicast: formatCartesiaAccessToken(resolved || payload) }),
          (err) => ({
            unicast: formatCartesiaAccessTokenError({
              voiceSessionId: payload.voiceSessionId,
              error: err && err.message ? err.message : "requestCartesiaAccessToken failed",
              code: normalizeCartesiaAccessTokenErrorCode(err),
            }),
          }),
        );
      }
      return { unicast: formatCartesiaAccessToken(result || payload) };
    } catch (err) {
      return {
        unicast: formatCartesiaAccessTokenError({
          voiceSessionId: payload.voiceSessionId,
          error: err && err.message ? err.message : "requestCartesiaAccessToken failed",
          code: normalizeCartesiaAccessTokenErrorCode(err),
        }),
      };
    }
  }

  return {
    handleGetSonioxModels,
    handleGetHermesSttCapabilities,
    handleHermesSttTranscribe,
    handleRequestSonioxTemporaryKey,
    handleRequestCartesiaAccessToken,
  };
}

module.exports = { createVoiceHandlers };
