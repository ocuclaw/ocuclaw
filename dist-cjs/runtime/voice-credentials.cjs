const crypto = require("node:crypto");
const { voiceNetworkCause } = require("../domain/voice-network-cause.cjs");
const { normalizeSonioxTemporaryKeyErrorCodeForRelay: normalizeSonioxTemporaryKeyErrorCode } = require("../domain/soniox-temp-key-errors.cjs");

const SONIOX_TEMP_KEY_URL = "https://api.soniox.com/v1/auth/temporary-api-key";
const SONIOX_MODELS_URL = "https://api.soniox.com/v1/models";
const DEFAULT_SONIOX_TEMP_KEY_EXPIRES_IN_SECONDS = 3600;

const DEFAULT_SONIOX_TEMP_KEY_MINT_TIMEOUT_MS = 8000;

const SONIOX_TEMP_KEY_REUSE_MIN_REMAINING_MS = 10 * 60_000;

const CARTESIA_ACCESS_TOKEN_URL = "https://api.cartesia.ai/access-token";
const CARTESIA_VERSION = "2026-03-01";
const DEFAULT_CARTESIA_ACCESS_TOKEN_EXPIRES_IN_SECONDS = 3600;
const DEFAULT_CARTESIA_ACCESS_TOKEN_MINT_TIMEOUT_MS = 8000;

function pickTrimmedString(...values           ) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function tailForLog(value         , maxChars = 160) {
  const text =
    typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function parseExpiryMs(raw         , nowMs        )                {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 10_000_000_000 ? Math.floor(raw) : nowMs + Math.floor(raw * 1000);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return parseExpiryMs(numeric, nowMs);
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  return null;
}

function normalizeSonioxTemporaryKeyResult(result     , voiceSessionId        , nowMs = Date.now()) {
  const temporaryKey = pickTrimmedString(
    result && result.temporaryKey,
    result && result.temporary_key,
    result && result.key,
    result && result.apiKey,
    result && result.api_key,
  );
  if (!temporaryKey) {
    throw new Error("Soniox temporary-key response missing temporaryKey");
  }

  const expiresAtMs =
    parseExpiryMs(
      result && (
        result.expiresAtMs ??
        result.expires_at_ms ??
        result.expiresAt ??
        result.expires_at
      ),
      nowMs,
    ) ??
    (
      Number.isFinite(result && result.expiresInSeconds)
        ? nowMs + Math.floor(result.expiresInSeconds * 1000)
        : null
    ) ??
    (
      Number.isFinite(result && result.expires_in_seconds)
        ? nowMs + Math.floor(result.expires_in_seconds * 1000)
        : null
    )          ;

  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
    throw new Error("Soniox temporary-key response missing expiresAtMs");
  }

  return {
    voiceSessionId,
    temporaryKey,
    expiresAtMs: Math.floor(expiresAtMs),
  };
}

function normalizeSonioxModelEntryRows(result     ) {
  const rows =
    result &&
    typeof result === "object" &&
    Array.isArray(result.models)
      ? result.models
      : [];
  const models                     = [];
  const seenIds = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const transcriptionMode =
      typeof row.transcription_mode === "string"
        ? row.transcription_mode.trim()
        : "";
    if (transcriptionMode !== "real_time") continue;
    if (row.aliased_model_id !== undefined && row.aliased_model_id !== null) {
      const aliasedModelId = pickTrimmedString(row.aliased_model_id);
      if (aliasedModelId) continue;
    }
    const id = pickTrimmedString(row.id);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    models.push({
      id,
      name: pickTrimmedString(row.name) || id,
      supportsMaxEndpointDelay: row.supports_max_endpoint_delay === true,
      languages: normalizeSonioxLanguageRows(row.languages),
    });
  }
  return models;
}

function normalizeSonioxLanguageRows(rows         ) {
  if (!Array.isArray(rows)) return [];
  const languages                                = [];
  const seenCodes = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const code = pickTrimmedString(row.code).toLowerCase();
    if (!code || seenCodes.has(code)) continue;
    seenCodes.add(code);
    languages.push({ code, name: pickTrimmedString(row.name) || code });
  }
  return languages;
}

function createVoiceCredentials(ctx                         ) {
  const { opts, logger, emitDebug, sessionService } = ctx;

  const configuredSonioxApiKey =
    opts.sonioxApiKey !== undefined
      ? opts.sonioxApiKey
      : (opts.config && opts.config.sonioxApiKey) || "";
  const sonioxTemporaryKeyExpiresInSeconds = Number.isFinite(
    opts.sonioxTemporaryKeyExpiresInSeconds,
  )
    ? Math.max(30, Math.floor(opts.sonioxTemporaryKeyExpiresInSeconds ))
    : DEFAULT_SONIOX_TEMP_KEY_EXPIRES_IN_SECONDS;
  const sonioxTemporaryKeyMintTimeoutMs = Number.isFinite(
    opts.sonioxTemporaryKeyMintTimeoutMs,
  )
    ? Math.max(1, Math.floor(opts.sonioxTemporaryKeyMintTimeoutMs ))
    : DEFAULT_SONIOX_TEMP_KEY_MINT_TIMEOUT_MS;
  const configuredCartesiaApiKey =
    opts.cartesiaApiKey !== undefined
      ? opts.cartesiaApiKey
      : (opts.config && opts.config.cartesiaApiKey) || "";
  const cartesiaAccessTokenExpiresInSeconds = Number.isFinite(
    opts.cartesiaAccessTokenExpiresInSeconds,
  )
    ? Math.max(30, Math.min(3600, Math.floor(opts.cartesiaAccessTokenExpiresInSeconds )))
    : DEFAULT_CARTESIA_ACCESS_TOKEN_EXPIRES_IN_SECONDS;
  const cartesiaAccessTokenMintTimeoutMs = Number.isFinite(
    opts.cartesiaAccessTokenMintTimeoutMs,
  )
    ? Math.max(1, Math.floor(opts.cartesiaAccessTokenMintTimeoutMs ))
    : DEFAULT_CARTESIA_ACCESS_TOKEN_MINT_TIMEOUT_MS;
  let cachedSonioxModels                            = null;
  let cachedSonioxModelsFetchedAt = 0;
  let cachedSonioxModelsStale = true;
  let sonioxModelsFetchStarted = false;
  let inFlightSonioxModelsFetch                                       = null;

  let cachedSonioxTemporaryKey                                      = null;
  let inFlightSonioxTemporaryKeyMint                                               = null;
  let inFlightSonioxMintTiming      = null;

  function resolveFetchImpl() {
    return typeof opts.fetch === "function"
      ? opts.fetch
      : typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : null;
  }

  function sonioxModelsSnapshot(nowMs         )                       {
    const now = Number.isFinite(nowMs) ? nowMs  : Date.now();
    const hasCache = Array.isArray(cachedSonioxModels);
    return {
      models: hasCache ? cachedSonioxModels  : [],
      fetchedAtMs: hasCache ? cachedSonioxModelsFetchedAt : now,
      stale: !hasCache || cachedSonioxModelsStale,
    };
  }

  function cacheSonioxModels(models                    , fetchedAtMs        , stale         ) {
    cachedSonioxModels = Array.isArray(models) ? models : [];
    cachedSonioxModelsFetchedAt = Number.isFinite(fetchedAtMs)
      ? Math.floor(fetchedAtMs)
      : Date.now();
    cachedSonioxModelsStale = !!stale;
    return sonioxModelsSnapshot(cachedSonioxModelsFetchedAt);
  }

  function getSonioxModelsSnapshot() {
    if (inFlightSonioxModelsFetch) {
      return inFlightSonioxModelsFetch;
    }
    return Promise.resolve(sonioxModelsSnapshot());
  }

  function prefetchSonioxModels(trigger = "relay_start") {
    if (inFlightSonioxModelsFetch) {
      return inFlightSonioxModelsFetch;
    }
    if (sonioxModelsFetchStarted) {
      return Promise.resolve(sonioxModelsSnapshot());
    }
    sonioxModelsFetchStarted = true;

    const fetchImpl = resolveFetchImpl();
    if (!configuredSonioxApiKey) {
      const snapshot = cacheSonioxModels([], Date.now(), true);
      emitDebug(
        "voice.timeline",
        "soniox_models_prefetch_skipped",
        "warn",
        { sessionKey: sessionService.peekSessionKey() || undefined },
        () => ({
          trigger,
          reason: "api_key_not_configured",
        }),
      );
      return Promise.resolve(snapshot);
    }
    if (!fetchImpl) {
      const snapshot = cacheSonioxModels([], Date.now(), true);
      emitDebug(
        "voice.timeline",
        "soniox_models_prefetch_skipped",
        "warn",
        { sessionKey: sessionService.peekSessionKey() || undefined },
        () => ({
          trigger,
          reason: "fetch_unavailable",
        }),
      );
      return Promise.resolve(snapshot);
    }

    inFlightSonioxModelsFetch = Promise.resolve()
      .then(async () => {
        const response = await fetchImpl(SONIOX_MODELS_URL, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${configuredSonioxApiKey}`,
          },
        });
        const rawText =
          response && typeof response.text === "function"
            ? await response.text()
            : "";
        let payload      = {};
        if (rawText) {
          try {
            payload = JSON.parse(rawText);
          } catch {
            if (!response.ok) {
              throw new Error(
                `Soniox models request failed (${response.status}): ${tailForLog(rawText)}`,
              );
            }
            throw new Error(
              `Soniox models response was not valid JSON (${response.status})`,
            );
          }
        }
        if (!response.ok) {
          const errorDetail = pickTrimmedString(
            payload && payload.error,
            payload && payload.message,
            payload && payload.detail,
            rawText,
          ) || `HTTP ${response.status}`;
          throw new Error(
            `Soniox models request failed (${response.status}): ${tailForLog(errorDetail)}`,
          );
        }
        const snapshot = cacheSonioxModels(
          normalizeSonioxModelEntryRows(payload || {}),
          Date.now(),
          false,
        );
        emitDebug(
          "voice.timeline",
          "soniox_models_prefetched",
          "info",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            trigger,
            count: snapshot.models.length,
            stale: snapshot.stale,
          }),
        );
        return snapshot;
      })
      .catch((err) => {
        const snapshot = Array.isArray(cachedSonioxModels)
          ? cacheSonioxModels(cachedSonioxModels, cachedSonioxModelsFetchedAt, true)
          : cacheSonioxModels([], Date.now(), true);
        emitDebug(
          "voice.timeline",
          "soniox_models_prefetch_failed",
          "warn",
          { sessionKey: sessionService.peekSessionKey() || undefined },
          () => ({
            trigger,
            message: err && err.message ? err.message : String(err),
          }),
        );
        return snapshot;
      })
      .finally(() => {
        inFlightSonioxModelsFetch = null;
      });

    return inFlightSonioxModelsFetch;
  }

  async function fetchMintWithDeadline(fetchImpl     , url     , init     , timeoutMs     , timing      = {}) {
    const startedAt = Date.now();
    timing.stage = "headers";
    const controller = new AbortController();
    let timer      = null;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const err      = new Error(`mint timed out after ${timeoutMs} ms`);
        err.name = "AbortError";
        reject(err);
      }, timeoutMs);
    });
    try {
      const response      = await Promise.race([
        fetchImpl(url, { ...init, signal: controller.signal }),
        deadline,
      ]);
      timing.headersMs = Date.now() - startedAt;
      timing.httpStatus = response.status;
      timing.stage = "body";
      const rawText =
        response && typeof response.text === "function"
          ? await Promise.race([response.text(), deadline])
          : "";
      timing.bodyMs = Date.now() - startedAt - timing.headersMs;
      timing.stage = "decode";
      return { response, rawText };
    } finally {
      clearTimeout(timer);
    }
  }

  function mintTimingFields(startedAtMs     , timing     ) {
    const phase = (v     ) => (Number.isFinite(v) ? v : null);
    return {
      elapsedMs: Date.now() - startedAtMs,
      headersMs: phase(timing.headersMs),
      bodyMs: phase(timing.bodyMs),
      ...(timing.networkRequestId ? { networkRequestId: timing.networkRequestId,
        requestStartedAtMs: timing.requestStartedAtMs,
        requestElapsedMs: timing.requestElapsedMs ?? Date.now() - timing.requestStartedAtMs } : {}),
    };
  }

  function formatMintTiming(fields     ) {
    const show = (v     ) => (v === null ? "-" : v);
    return `elapsedMs=${fields.elapsedMs} headersMs=${show(fields.headersMs)} bodyMs=${show(fields.bodyMs)}`;
  }

  async function mintSonioxTemporaryKey(clientId        , request                        ) {
    const voiceSessionId = pickTrimmedString(request && request.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }

    const sessionKey = pickTrimmedString(request && request.sessionKey) || null;
    const nowMs = Date.now();
    const resolvedSessionKey = sessionKey || sessionService.peekSessionKey() || undefined;
    const mintTiming      = { stage: "configuration" };
    const preparationPurpose = ["foreground", "warm_spare"].includes(request?.preparationPurpose) ? request.preparationPurpose : "unknown";
    const emitIssued =                                    (normalized   , source        ) => {
      const timing = mintTimingFields(nowMs, mintTiming);
      logger.info(
        `[relay] soniox temp key issued: clientId=${clientId} voiceSessionId=${voiceSessionId} source=${source} expiresAtMs=${normalized.expiresAtMs} ${formatMintTiming(timing)}`,
      );
      emitDebug(
        "voice.timeline",
        "soniox_temp_key_issued",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({
          clientId,
          voiceSessionId,
          expiresAtMs: normalized.expiresAtMs,
          source,
          preparationPurpose,
          ...timing,
        }),
      );
      return normalized;
    };

    try {
      emitDebug(
        "voice.timeline",
        "soniox_temp_key_requested",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({
          clientId,
          voiceSessionId,
          expiresInSeconds: sonioxTemporaryKeyExpiresInSeconds,
          preparationPurpose,
        }),
      );

      if (typeof opts.createSonioxTemporaryKey === "function") {
        mintTiming.stage = "unknown";
        const overrideResult = await Promise.resolve(
          opts.createSonioxTemporaryKey({
            voiceSessionId,
            sessionKey,
            expiresInSeconds: sonioxTemporaryKeyExpiresInSeconds,
          }),
        );
        return emitIssued(
          normalizeSonioxTemporaryKeyResult(
            overrideResult || {},
            voiceSessionId,
            nowMs,
          ),
          "override",
        );
      }

      if (!configuredSonioxApiKey) {

        throw new Error(
          "Soniox API key is not configured. If you just saved it, activate it from your phone.",
        );
      }

      if (
        cachedSonioxTemporaryKey &&
        cachedSonioxTemporaryKey.servedVoiceSessionIds.has(voiceSessionId)
      ) {

        cachedSonioxTemporaryKey = null;
      }
      const reusable =
        cachedSonioxTemporaryKey &&
        cachedSonioxTemporaryKey.expiresAtMs - nowMs >=
          SONIOX_TEMP_KEY_REUSE_MIN_REMAINING_MS
          ? cachedSonioxTemporaryKey
          : null;
      const source = reusable ? "cache" : "soniox_api";
      const entry =
        reusable || (await mintSharedSonioxTemporaryKey(voiceSessionId, mintTiming));
      Object.assign(mintTiming, entry.timing);
      entry.servedVoiceSessionIds.add(voiceSessionId);
      return emitIssued(
        {
          voiceSessionId,
          temporaryKey: entry.temporaryKey,
          expiresAtMs: entry.expiresAtMs,
        },
        source,
      );
    } catch (err     ) {
      const message =
        err && err.message
          ? err.message
          : "Soniox temporary-key request failed";
      const code = normalizeSonioxTemporaryKeyErrorCode(err);
      const timing = mintTimingFields(nowMs, mintTiming);
      logger.warn(
        `[relay] soniox temp key failed: clientId=${clientId} voiceSessionId=${voiceSessionId} code=${code} ${formatMintTiming(timing)} message=${tailForLog(message)}`,
      );
      emitDebug(
        "voice.timeline",
        "soniox_temp_key_failed",
        "warn",
        { sessionKey: resolvedSessionKey },
        () => ({
          clientId,
          voiceSessionId,
          code,
          preparationPurpose,
          networkCause: voiceNetworkCause(err, { service: "soniox", stage: mintTiming.stage,
            httpStatus: mintTiming.httpStatus, elapsedMs: timing.elapsedMs }),
          ...timing,
        }),
      );
      throw err;
    }
  }

  async function mintSharedSonioxTemporaryKey(
    voiceSessionId        ,
    timing      = {},
  )                                        {
    if (!inFlightSonioxTemporaryKeyMint) {
      inFlightSonioxMintTiming = { networkRequestId: crypto.randomUUID(), requestStartedAtMs: Date.now(), stage: "headers" };
      const sharedTiming = inFlightSonioxMintTiming;
      inFlightSonioxTemporaryKeyMint = fetchSonioxTemporaryKey(voiceSessionId, sharedTiming)
        .then((minted) => {
          const entry                               = {
            temporaryKey: minted.temporaryKey,
            expiresAtMs: minted.expiresAtMs,
            timing: sharedTiming,
            servedVoiceSessionIds: new Set(),
          };
          cachedSonioxTemporaryKey = entry;
          return entry;
        })
        .finally(() => {
          sharedTiming.requestElapsedMs = Date.now() - sharedTiming.requestStartedAtMs;
          inFlightSonioxTemporaryKeyMint = null;
        });
    }
    const sharedTiming = inFlightSonioxMintTiming;
    try { return await inFlightSonioxTemporaryKeyMint; }
    finally { Object.assign(timing, sharedTiming); }
  }

  async function fetchSonioxTemporaryKey(voiceSessionId        , timing      = {}) {
    const nowMs = Date.now();
    const fetchImpl = resolveFetchImpl();
    if (!fetchImpl) {
      throw new Error("fetch is not available for Soniox temporary-key minting");
    }

    const { response, rawText } = await fetchMintWithDeadline(
      fetchImpl,
      SONIOX_TEMP_KEY_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${configuredSonioxApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          usage_type: "transcribe_websocket",
          expires_in_seconds: sonioxTemporaryKeyExpiresInSeconds,
          client_reference_id: voiceSessionId,
        }),
      },
      sonioxTemporaryKeyMintTimeoutMs,
      timing,
    );
    let payload      = {};
    if (rawText) {
      try {
        payload = JSON.parse(rawText);
      } catch (err) {
        if (!response.ok) {
          throw new Error(
            `Soniox temporary-key request failed (${response.status}): ${tailForLog(rawText)}`,
          );
        }
        throw new Error(
          `Soniox temporary-key response was not valid JSON (${response.status})`,
        );
      }
    }

    if (!response.ok) {
      const errorDetail = pickTrimmedString(
        payload && payload.error,
        payload && payload.message,
        payload && payload.detail,
        rawText,
      ) || `HTTP ${response.status}`;
      throw new Error(
        `Soniox temporary-key request failed (${response.status}): ${tailForLog(errorDetail)}`,
      );
    }

    return normalizeSonioxTemporaryKeyResult(
      payload || {},
      voiceSessionId,
      nowMs,
    );
  }

  function normalizeCartesiaAccessTokenResult(result     , voiceSessionId        , nowMs        ) {
    const accessToken =
      pickTrimmedString(result && (result.accessToken || result.token)) || "";
    if (!accessToken) {
      throw new Error("Cartesia access-token response missing token");
    }
    const expiresInSeconds = Number.isFinite(result && result.expiresInSeconds)
      ? result.expiresInSeconds
      : cartesiaAccessTokenExpiresInSeconds;
    const expiresAtMs = Number.isFinite(result && result.expiresAtMs)
      ? Math.floor(result.expiresAtMs)
      : Math.floor(nowMs + expiresInSeconds * 1000);
    return { voiceSessionId, accessToken, expiresAtMs };
  }

  async function mintCartesiaAccessToken(clientId        , request                        ) {
    const voiceSessionId = pickTrimmedString(request && request.voiceSessionId);
    if (!voiceSessionId) {
      throw new Error("voiceSessionId is required");
    }
    const sessionKey = pickTrimmedString(request && request.sessionKey) || null;
    const nowMs = Date.now();
    const resolvedSessionKey = sessionKey || sessionService.peekSessionKey() || undefined;
    const mintTiming      = { stage: "configuration" };
    const emitIssued =                                    (normalized   , source        ) => {
      const timing = mintTimingFields(nowMs, mintTiming);
      logger.info(
        `[relay] cartesia access token issued: clientId=${clientId} voiceSessionId=${voiceSessionId} source=${source} expiresAtMs=${normalized.expiresAtMs} ${formatMintTiming(timing)}`,
      );
      emitDebug(
        "voice.timeline",
        "cartesia_access_token_issued",
        "info",
        { sessionKey: resolvedSessionKey },
        () => ({ clientId, voiceSessionId, expiresAtMs: normalized.expiresAtMs, source, ...timing }),
      );
      return normalized;
    };

    try {
      if (typeof opts.createCartesiaAccessToken === "function") {
        mintTiming.stage = "unknown";
        const overrideResult = await Promise.resolve(
          opts.createCartesiaAccessToken({
            voiceSessionId,
            sessionKey,
            expiresInSeconds: cartesiaAccessTokenExpiresInSeconds,
          }),
        );
        return emitIssued(
          normalizeCartesiaAccessTokenResult(overrideResult || {}, voiceSessionId, nowMs),
          "override",
        );
      }

      if (!configuredCartesiaApiKey) {
        throw new Error("Cartesia API key is not configured");
      }
      const fetchImpl = resolveFetchImpl();
      if (!fetchImpl) {
        throw new Error("fetch is not available for Cartesia access-token minting");
      }

      const { response, rawText } = await fetchMintWithDeadline(
        fetchImpl,
        CARTESIA_ACCESS_TOKEN_URL,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${configuredCartesiaApiKey}`,
            "Cartesia-Version": CARTESIA_VERSION,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grants: { stt: true },
            expires_in: cartesiaAccessTokenExpiresInSeconds,
          }),
        },
        cartesiaAccessTokenMintTimeoutMs,
        mintTiming,
      );
      let payload      = {};
      if (rawText) {
        try {
          payload = JSON.parse(rawText);
        } catch (err) {
          throw new Error(
            `Cartesia access-token response was not valid JSON (${response.status})`,
          );
        }
      }
      if (!response.ok) {
        const errorDetail =
          pickTrimmedString(
            payload && payload.message,
            payload && payload.error,
            rawText,
          ) || `HTTP ${response.status}`;
        throw new Error(
          `Cartesia access-token request failed (${response.status}): ${tailForLog(errorDetail)}`,
        );
      }

      return emitIssued(
        normalizeCartesiaAccessTokenResult(
          { token: payload && payload.token },
          voiceSessionId,
          nowMs,
        ),
        "cartesia_api",
      );
    } catch (err     ) {
      const message = err && err.message ? err.message : "Cartesia access-token request failed";
      const timing = mintTimingFields(nowMs, mintTiming);
      logger.warn(
        `[relay] cartesia access token failed: clientId=${clientId} voiceSessionId=${voiceSessionId} ${formatMintTiming(timing)} message=${tailForLog(message)}`,
      );
      emitDebug(
        "voice.timeline",
        "cartesia_access_token_failed",
        "warn",
        { sessionKey: resolvedSessionKey },
        () => ({ clientId, voiceSessionId, ...timing,
          networkCause: voiceNetworkCause(err, { service: "cartesia", stage: mintTiming.stage,
            httpStatus: mintTiming.httpStatus, elapsedMs: timing.elapsedMs }) }),
      );
      throw err;
    }
  }

  return {
    getSonioxModelsSnapshot,
    prefetchSonioxModels,
    mintSonioxTemporaryKey,
    mintCartesiaAccessToken,
  };
}

module.exports = { createVoiceCredentials };
