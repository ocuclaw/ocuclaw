const { RPC_METHOD_NOT_FOUND_CODE } = require("./hermes-control-link.cjs");
const { createHermesSttUpload } = require("./hermes-stt-upload.cjs");
const { discardLinkSpillFileAsync, writeLinkSpillFile } = require("./link-attachment-spill.cjs");

const LINK_STT_METHODS = Object.freeze({
  capabilitiesList: "stt.capabilities.list",
  transcribe: "stt.transcribe",
});

const LINK_STT_CAPABILITIES_TIMEOUT_MS = 10_000;

const LINK_STT_TRANSCRIBE_TIMEOUT_MS = 60_000;

const STT_SPILL_FILE_PREFIX = "ocuclaw-stt-";

const STT_CAPABILITIES_STATUS = Object.freeze({
  ok: "ok",
  offline: "offline",
  error: "error",
});

const LINK_DOWN_MESSAGES = Object.freeze([
  "control link closed",
  "control link not ready",
]);

function isLinkDownError(err) {
  const message = err && err.message ? String(err.message) : "";
  return LINK_DOWN_MESSAGES.includes(message);
}

function normalizeSttCapabilitiesErrorCode(err) {
  const code = err ? err.code : undefined;
  if (code === RPC_METHOD_NOT_FOUND_CODE) return "method_not_found";

  if (typeof code === "string" && code.trim()) return code.trim();
  if (Number.isFinite(code)) return `link_rpc_${code}`;
  return "link_rpc_failed";
}

function offlineSttCapabilitiesSnapshot() {
  return { status: STT_CAPABILITIES_STATUS.offline, providers: [] };
}

const STT_TRANSCRIBE_ERROR_CODES = Object.freeze({

  offline: "offline",

  invalidRequest: "invalid_request",

  spillFailed: "spill_failed",

  transcribeFailed: "transcribe_failed",
});

const OFFLINE_TRANSCRIBE_MESSAGE =
  "no live Hermes link: speech-to-text is unavailable on this host";

function cleanIdentifier(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function cleanFreeText(raw) {
  if (typeof raw !== "string") return null;
  return raw.trim() || null;
}

function offlineSttTranscribeResult(provider) {
  return {
    success: false,
    provider: cleanIdentifier(provider),
    error: {
      code: STT_TRANSCRIBE_ERROR_CODES.offline,
      message: OFFLINE_TRANSCRIBE_MESSAGE,
    },
  };
}

function transcribeFailure(provider, code, message) {
  return {
    success: false,
    provider: cleanIdentifier(provider),
    error: { code, message },
  };
}

function normalizeEnvelopeError(raw) {
  if (typeof raw === "string" && raw.trim()) {
    return {
      code: STT_TRANSCRIBE_ERROR_CODES.transcribeFailed,
      message: raw,
    };
  }
  if (raw && typeof raw === "object") {
    const code = cleanIdentifier(raw.code);
    const message = typeof raw.message === "string" && raw.message ? raw.message : null;
    return {
      code: code || STT_TRANSCRIBE_ERROR_CODES.transcribeFailed,
      message: message || "transcription failed",
    };
  }
  return {
    code: STT_TRANSCRIBE_ERROR_CODES.transcribeFailed,
    message: "transcription failed",
  };
}

function createHermesSttLane(deps = {}) {
  const link = deps && deps.link ? deps.link : null;
  const logger = deps && deps.logger ? deps.logger : null;

  function warn(message) {
    if (logger && typeof logger.warn === "function") logger.warn(message);
  }

  function linkIsDown() {
    if (!link || typeof link.request !== "function") return true;
    return typeof link.isReady === "function" && !link.isReady();
  }

  function getCapabilities() {
    if (linkIsDown()) {
      return Promise.resolve(offlineSttCapabilitiesSnapshot());
    }
    return Promise.resolve(
      link.request(
        LINK_STT_METHODS.capabilitiesList,
        {},
        { timeoutMs: LINK_STT_CAPABILITIES_TIMEOUT_MS },
      ),
    ).then(
      (result) => ({

        status: STT_CAPABILITIES_STATUS.ok,
        uploadProtocolVersion: 1,
        providers:
          result && Array.isArray(result.providers) ? result.providers : [],
      }),
      (err) => {
        if (isLinkDownError(err)) return offlineSttCapabilitiesSnapshot();
        const code = normalizeSttCapabilitiesErrorCode(err);
        warn(
          `[hermes-stt] ${LINK_STT_METHODS.capabilitiesList} failed (${code})`,
        );
        return {
          status: STT_CAPABILITIES_STATUS.error,
          providers: [],
          error: {
            code,
            message:
              err && err.message
                ? String(err.message)
                : "stt capability listing failed",
          },
        };
      },
    );
  }

  async function transcribe(request = {}) {
    const req = request && typeof request === "object" ? request : {};
    const provider = cleanIdentifier(req.provider);
    const audio = req.audio && typeof req.audio === "object" ? req.audio : null;
    const content =
      audio && typeof audio.content === "string" ? audio.content : "";

    if (linkIsDown()) {
      return offlineSttTranscribeResult(provider);
    }
    if (!provider) {
      return transcribeFailure(
        provider,
        STT_TRANSCRIBE_ERROR_CODES.invalidRequest,
        "transcribe requires a provider id",
      );
    }
    if (!content) {
      return transcribeFailure(
        provider,
        STT_TRANSCRIBE_ERROR_CODES.invalidRequest,
        "transcribe requires base64 audio content",
      );
    }

    let spillPath;
    try {
      spillPath = await writeLinkSpillFile(content, {
        prefix: STT_SPILL_FILE_PREFIX,
      });
    } catch (err) {
      const message = err && err.message ? String(err.message) : "spill failed";
      warn(`[hermes-stt] could not stage transcribe audio: ${message}`);
      return transcribeFailure(
        provider,
        STT_TRANSCRIBE_ERROR_CODES.spillFailed,
        message,
      );
    }

    return transcribeStaged(req, spillPath, audio);
  }

  async function transcribeStaged(req, spillPath, audio = {
    format: "wav", sampleRateHz: 16000, channels: 1,
  }) {
    const provider = cleanIdentifier(req.provider);

    const audioParams = {};
    for (const field of ["format", "sampleRateHz", "channels"]) {
      if (audio && audio[field] !== undefined) audioParams[field] = audio[field];
    }
    audioParams.path = spillPath;
    const params = {
      provider,
      model: cleanIdentifier(req.model),
      language: cleanIdentifier(req.language),
      prompt: cleanFreeText(req.prompt),
      audio: audioParams,
    };

    return Promise.resolve().then(() =>
      link.request(LINK_STT_METHODS.transcribe, params, {
        timeoutMs: LINK_STT_TRANSCRIBE_TIMEOUT_MS,
      }),
    ).then(
      async (result) => {

        await discardLinkSpillFileAsync(spillPath);
        const envelope = result && typeof result === "object" ? result : {};
        const echoed = cleanIdentifier(envelope.provider) || provider;
        if (envelope.success === true) {
          return {
            success: true,
            provider: echoed,
            transcript:
              typeof envelope.transcript === "string" ? envelope.transcript : "",
          };
        }
        return {
          success: false,
          provider: echoed,
          error: normalizeEnvelopeError(envelope.error),
        };
      },
      async (err) => {
        await discardLinkSpillFileAsync(spillPath);
        if (isLinkDownError(err)) return offlineSttTranscribeResult(provider);
        const code = normalizeSttCapabilitiesErrorCode(err);
        warn(`[hermes-stt] ${LINK_STT_METHODS.transcribe} failed (${code})`);
        return transcribeFailure(
          provider,
          code,
          err && err.message ? String(err.message) : "transcription failed",
        );
      },
    );
  }

  const upload = createHermesSttUpload({
    isReady: () => !linkIsDown(), transcribeStaged,
  });
  return { getCapabilities, transcribe, upload };
}

module.exports = { LINK_STT_METHODS, LINK_STT_CAPABILITIES_TIMEOUT_MS, LINK_STT_TRANSCRIBE_TIMEOUT_MS, STT_SPILL_FILE_PREFIX, STT_CAPABILITIES_STATUS, STT_TRANSCRIBE_ERROR_CODES, normalizeSttCapabilitiesErrorCode, offlineSttCapabilitiesSnapshot, offlineSttTranscribeResult, createHermesSttLane };
