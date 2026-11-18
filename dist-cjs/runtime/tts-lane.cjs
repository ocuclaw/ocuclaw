const fsDefault = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");

const TTS_CAPABILITIES_STATUS = Object.freeze({
  ok: "ok",
  offline: "offline",
  error: "error",
});

const TTS_ERROR_CODES = Object.freeze({
  offline: "offline",
  invalidRequest: "invalid_request",
  tooLong: "text_too_long",
  speakFailed: "speak_failed",
  tooLarge: "audio_too_large",

  noProvider: "no_provider",
});

const TTS_MAX_TEXT_CHARS = 800;

const TTS_MAX_AUDIO_BYTES = 3_000_000;
const TTS_CAPABILITIES_TIMEOUT_MS = 10_000;
const TTS_SPEAK_TIMEOUT_MS = 60_000;

const TTS_SPILL_FILE_PREFIX = "ocuclaw-tts-";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/;

function cleanId(value     ) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && ID_RE.test(text) ? text : "";
}

function errorMessage(err     , fallback        ) {
  const text = err && typeof err.message === "string" ? err.message.trim() : "";
  return (text || fallback).slice(0, 300);
}

const NO_PROVIDER_RE = /no (?:tts )?provider|not configured|no api key|missing api key/i;

function isNoProviderMessage(message     ) {
  return typeof message === "string" && NO_PROVIDER_RE.test(message);
}

function offlineTtsCapabilities() {
  return { status: TTS_CAPABILITIES_STATUS.offline, active: null, canChoose: false, providers: [], maxChars: TTS_MAX_TEXT_CHARS };
}

function sniffAudioMimeType(bytes     , hint      = "") {
  if (bytes && bytes.length >= 4) {
    const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
    if (head.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
    if (head.startsWith("OggS")) return "audio/ogg";
    if (head.startsWith("RIFF")) return "audio/wav";
    if (head.startsWith("fLaC")) return "audio/flac";
    if (head.slice(4, 8) === "ftyp") return "audio/mp4";
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "audio/webm";
  }
  const name = String(hint || "").toLowerCase();
  if (name.startsWith("audio/")) return name;
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".ogg") || name.endsWith(".opus")) return "audio/ogg";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a") || name.endsWith(".mp4")) return "audio/mp4";
  if (name.endsWith(".webm")) return "audio/webm";
  return "audio/mpeg";
}

function normalizeVoices(raw     ) {
  if (!Array.isArray(raw)) return [];
  const voices                                       = [];
  const seen = new Set        ();
  for (const entry of raw) {
    const id = cleanId(typeof entry === "string" ? entry : entry && (entry.id ?? entry.voiceId ?? entry.name));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = entry && typeof entry === "object"
      ? String(entry.label ?? entry.name ?? entry.display ?? id).trim().slice(0, 80) || id
      : id;
    voices.push({ id, label });
    if (voices.length >= 200) break;
  }
  return voices;
}

function normalizeTtsProviders(raw     ) {
  if (!Array.isArray(raw)) return [];
  const providers        = [];
  const seen = new Set        ();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const id = cleanId(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const available = entry.available === true || entry.configured === true;
    const row      = {
      id,
      label: String(entry.label ?? entry.name ?? id).trim().slice(0, 80) || id,
      available,
      voices: normalizeVoices(entry.voices),
    };
    const voice = cleanId(entry.voice);
    if (voice) row.voice = voice;
    if (!available) {
      const reason = typeof entry.unavailableReason === "string" ? entry.unavailableReason.trim().slice(0, 200) : "";
      if (reason) row.unavailableReason = reason;
    }
    providers.push(row);
    if (providers.length >= 64) break;
  }
  return providers;
}

function createTtsLane(deps      = {}) {
  const request = typeof deps.request === "function" ? deps.request : null;
  const backendKind = () => (typeof deps.backendKind === "function" ? deps.backendKind() : deps.backendKind) === "hermes" ? "hermes" : "openclaw";
  const fs = deps.fs || fsDefault;
  const tmpdir = typeof deps.tmpdir === "function" ? deps.tmpdir : os.tmpdir;
  const logger = deps.logger || null;

  function warn(message        ) {
    if (logger && typeof logger.warn === "function") logger.warn(message);
  }

  function call(method        , params     , timeoutMs        ) {
    let timer      = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The agent took too long to answer")), timeoutMs + 2_000);
    });
    return Promise.race([Promise.resolve().then(() => request(method, params, { timeoutMs })), timeout])
      .finally(() => clearTimeout(timer));
  }

  function isOffline(err     ) {
    const code = err && (err.code ?? err.errorCode);
    const text = String(err && err.message ? err.message : "").toLowerCase();
    return code === -32601 || code === "METHOD_NOT_FOUND" || text.includes("method not found") ||
      text.includes("unknown method") || text.includes("not connected") || text.includes("link is down");
  }

  async function getCapabilities() {
    if (!request) return offlineTtsCapabilities();
    const hermes = backendKind() === "hermes";
    try {
      const result      = await call(hermes ? "tts.capabilities" : "tts.providers", {}, TTS_CAPABILITIES_TIMEOUT_MS);
      const providers = normalizeTtsProviders(result && result.providers);
      const active = cleanId(result && result.active) || null;
      return {
        status: TTS_CAPABILITIES_STATUS.ok,
        active,

        canChoose: !hermes,
        providers,
        maxChars: TTS_MAX_TEXT_CHARS,
      };
    } catch (err     ) {
      if (isOffline(err)) return offlineTtsCapabilities();
      warn(`[tts] capability listing failed: ${errorMessage(err, "unknown")}`);
      return {
        ...offlineTtsCapabilities(),
        status: TTS_CAPABILITIES_STATUS.error,
        error: { code: "list_failed", message: errorMessage(err, "Could not list voices") },
      };
    }
  }

  function failure(code        , message        , provider                = null) {
    return { success: false, provider, error: { code, message } };
  }

  function clip(bytes     , provider     , hint     ) {
    if (!bytes || bytes.length === 0) return failure(TTS_ERROR_CODES.speakFailed, "The agent returned no audio", cleanId(provider) || null);
    if (bytes.length > TTS_MAX_AUDIO_BYTES) return failure(TTS_ERROR_CODES.tooLarge, "The clip is too large to send", cleanId(provider) || null);
    return {
      success: true,
      provider: cleanId(provider) || null,
      mimeType: sniffAudioMimeType(bytes, hint),
      audioBase64: Buffer.from(bytes).toString("base64"),
    };
  }

  async function speakOpenClaw(text        , provider        , voice        ) {
    if (!provider && !voice) {
      const result      = await call("tts.speak", { text }, TTS_SPEAK_TIMEOUT_MS);
      const base64 = result && typeof result.audioBase64 === "string" ? result.audioBase64 : "";
      return clip(Buffer.from(base64, "base64"), result && result.provider, (result && (result.mimeType || result.fileExtension)) || "");
    }
    const params      = { text };
    if (provider) params.provider = provider;
    if (voice) params.voiceId = voice;
    const result      = await call("tts.convert", params, TTS_SPEAK_TIMEOUT_MS);
    const audioPath = result && typeof result.audioPath === "string" ? result.audioPath : "";
    if (!audioPath || !path.isAbsolute(audioPath)) return failure(TTS_ERROR_CODES.speakFailed, "The agent returned no audio", provider || null);
    const stat = await fs.stat(audioPath);
    if (stat.size > TTS_MAX_AUDIO_BYTES) return failure(TTS_ERROR_CODES.tooLarge, "The clip is too large to send", provider || null);

    return clip(await fs.readFile(audioPath), (result && result.provider) || provider, audioPath);
  }

  async function speakHermes(text        , voice        ) {
    const dir = tmpdir();
    const stem = `${TTS_SPILL_FILE_PREFIX}${randomUUID()}`;
    const outputPath = path.join(dir, `${stem}.mp3`);
    let written = "";
    try {
      const params      = { text, outputPath };
      if (voice) params.voice = voice;
      const result      = await call("tts.speakFile", params, TTS_SPEAK_TIMEOUT_MS);
      if (!result || result.success !== true) {
        const error = result && result.error ? result.error : {};
        return failure(
          typeof error.code === "string" && error.code ? error.code : TTS_ERROR_CODES.speakFailed,
          errorMessage(error, "Hermes could not speak this"),
          cleanId(result && result.provider) || null,
        );
      }

      const candidate = typeof result.path === "string" ? result.path : "";
      if (path.dirname(candidate) !== dir || !path.basename(candidate).startsWith(stem)) {
        return failure(TTS_ERROR_CODES.speakFailed, "Hermes returned an unexpected file", cleanId(result.provider) || null);
      }
      written = candidate;
      const stat = await fs.stat(written);
      if (stat.size > TTS_MAX_AUDIO_BYTES) return failure(TTS_ERROR_CODES.tooLarge, "The clip is too large to send", cleanId(result.provider) || null);
      return clip(await fs.readFile(written), result.provider, written);
    } finally {
      for (const file of new Set([outputPath, written].filter(Boolean))) {
        await fs.unlink(file).catch(() => {});
      }
    }
  }

  async function speak(input      = {}) {
    const text = typeof input.text === "string" ? input.text.trim() : "";
    const provider = cleanId(input.provider);
    const voice = cleanId(input.voice);
    if (!text) return failure(TTS_ERROR_CODES.invalidRequest, "Nothing to speak");
    if (text.length > TTS_MAX_TEXT_CHARS) return failure(TTS_ERROR_CODES.tooLong, `Text is over ${TTS_MAX_TEXT_CHARS} characters`);
    if (!request) return failure(TTS_ERROR_CODES.offline, "Speech is not available on this agent");
    try {
      return backendKind() === "hermes" ? await speakHermes(text, voice) : await speakOpenClaw(text, provider, voice);
    } catch (err     ) {
      if (isOffline(err)) return failure(TTS_ERROR_CODES.offline, "Speech is not available on this agent", provider || null);
      warn(`[tts] speak failed: ${errorMessage(err, "unknown")}`);
      const message = errorMessage(err, "The agent could not speak this");
      const code = isNoProviderMessage(message) ? TTS_ERROR_CODES.noProvider : TTS_ERROR_CODES.speakFailed;
      return failure(code, message, provider || null);
    }
  }

  return { getCapabilities, speak };
}

const TTS_APP_PROTOCOL = Object.freeze({
  capabilitiesGet: "ocuclaw.voice.tts.capabilities.get",
  capabilitiesSnapshot: "ocuclaw.voice.tts.capabilities.snapshot",
  speak: "ocuclaw.voice.tts.speak",
  speakResult: "ocuclaw.voice.tts.speak.result",
});

function frameRequestId(msg     ) {
  return msg && typeof msg.requestId === "string" && msg.requestId ? msg.requestId.slice(0, 128) : null;
}

function formatTtsCapabilities(requestId     , payload      = {}) {
  const frame      = {
    type: TTS_APP_PROTOCOL.capabilitiesSnapshot,
    requestId: requestId || null,
    status: typeof payload.status === "string" && payload.status ? payload.status : TTS_CAPABILITIES_STATUS.offline,
    active: payload.active || null,
    canChoose: payload.canChoose === true,
    providers: Array.isArray(payload.providers) ? payload.providers : [],
    maxChars: Number.isFinite(payload.maxChars) ? payload.maxChars : TTS_MAX_TEXT_CHARS,
  };
  if (frame.status === TTS_CAPABILITIES_STATUS.error) {
    frame.error = {
      code: (payload.error && payload.error.code) || "list_failed",
      message: (payload.error && payload.error.message) || "Could not list voices",
    };
  }
  return JSON.stringify(frame);
}

function formatTtsSpeakResult(requestId     , payload      = {}) {
  const success = payload.success === true && typeof payload.audioBase64 === "string" && payload.audioBase64.length > 0;
  const frame      = {
    type: TTS_APP_PROTOCOL.speakResult,
    requestId: requestId || null,
    success,
    provider: payload.provider || null,
  };
  if (success) {
    frame.mimeType = payload.mimeType || "audio/mpeg";
    frame.audioBase64 = payload.audioBase64;
  } else {
    frame.error = {
      code: (payload.error && payload.error.code) || TTS_ERROR_CODES.speakFailed,
      message: (payload.error && payload.error.message) || "The agent could not speak this",
    };
  }
  return JSON.stringify(frame);
}

function createTtsDownstreamHandlers(deps      = {}) {
  const lane = deps.lane || null;
  return {
    handleGetTtsCapabilities(msg     ) {
      const requestId = frameRequestId(msg);
      return Promise.resolve(lane ? lane.getCapabilities() : offlineTtsCapabilities()).then(
        (payload     ) => ({ unicast: formatTtsCapabilities(requestId, payload) }),
        () => ({ unicast: formatTtsCapabilities(requestId, offlineTtsCapabilities()) }),
      );
    },
    handleTtsSpeak(msg     ) {
      const requestId = frameRequestId(msg);
      const offline = { success: false, provider: null, error: { code: TTS_ERROR_CODES.offline, message: "Speech is not available on this agent" } };
      return Promise.resolve(lane ? lane.speak(msg || {}) : offline).then(
        (payload     ) => ({ unicast: formatTtsSpeakResult(requestId, payload) }),
        () => ({ unicast: formatTtsSpeakResult(requestId, offline) }),
      );
    },
  };
}

module.exports = { TTS_CAPABILITIES_STATUS, TTS_ERROR_CODES, TTS_MAX_TEXT_CHARS, TTS_MAX_AUDIO_BYTES, TTS_CAPABILITIES_TIMEOUT_MS, TTS_SPEAK_TIMEOUT_MS, TTS_SPILL_FILE_PREFIX, isNoProviderMessage, offlineTtsCapabilities, sniffAudioMimeType, normalizeTtsProviders, createTtsLane, TTS_APP_PROTOCOL, formatTtsCapabilities, formatTtsSpeakResult, createTtsDownstreamHandlers };
