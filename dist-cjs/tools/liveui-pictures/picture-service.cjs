const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");
const { classifyPictureSource, decodePictureDataUrl, describePictureSource, redactPictureText } = require("./picture-source.cjs");
const { isPictureSeen, pictureLooksLike, sniffPicture } = require("./picture-sniff.cjs");
const { fetchPictureUrl, isPictureCopy, largerCopyUrls } = require("./picture-fetch.cjs");

const { resolvePicturePage } = require("./picture-pages.cjs");
const { MODEL_LANE } = require("./picture-lane.cjs");
const { readPictureFile } = require("./picture-file.cjs");
const { GLASS_MESH_TYPE, MODEL_PICTURE_CODES, modelFailureDetail, modelFailureSite, modelRefusedFormat } = require("./picture-model.cjs");
const { modelSiteLabel, modelSiteProvider, sanitizeModelSource } = require("./model-source.cjs");
const { createPictureByteStore } = require("./picture-store.cjs");

const { isVideoSource } = require("../liveui-video/video-service.cjs");
const { videoLookFor } = require("../liveui-video/video-look.cjs");
const { VIDEO_FAIL_DETAIL, isVideoFailDetail, isVideoToolReason, videoFailReasonOf } = require("../liveui-video/video-failure.cjs");

const LOOP_PICTURE_MIMES = ["image/gif", "image/webp"];

const LIVEUI_PICTURE_LIMITS                      = {
  concurrentPerSession: 2,
  holdIdleMs: 1000,
  refetchMinMs: 60_000,
  partChars: 49_152,
  sessionBytes: 16 * 1024 * 1024,
  processBytes: 64 * 1024 * 1024,
  toolRecheckMs: 5_000,
};

const PICTURE_DROP_LINE_MAX_BYTES = 120;

const PICTURE_STAGED_MAX_AGE_MS = 30_000;

const PICTURE_STAGED_MAX = 8;

const PICTURE_NO_LARGER = "picture_no_larger";

const PICTURE_CODES = [
  "picture_fetch_failed",
  "picture_host_refused",
  "picture_too_large",
  "picture_type_unsupported",
  "picture_unreadable",
  "picture_source_refused",
  "picture_bytes_inline",

  ...MODEL_PICTURE_CODES,
];

const MAX_WANT_IDS = 64;
const MAX_HAVE = 64;
const TRACE_TEXT_MAX = 64;

const DETAIL_BY_CODE                         = {
  picture_fetch_failed: "network",
  picture_host_refused: "host refused",
  picture_too_large: "too large",
  picture_type_unsupported: "type not supported",
  picture_unreadable: "unreadable",
  picture_source_refused: "source refused",
  picture_bytes_inline: "send the bytes through compose_glasses_ui",
};
const FETCH_DETAIL_RE = /^(http \d{1,3}|timeout|network|too many redirects)$/;
const SOURCE_REFUSED_DETAILS = new Set([
  "source refused",
  "web pictures off",
  "file pictures off here",
  "file pictures need a wearer's run",
]);

function pictureFailureDetail(code        , detail        )         {
  if (code === "picture_fetch_failed") return FETCH_DETAIL_RE.test(detail) || isVideoFailDetail(detail) ? detail : "network";
  if (code === "picture_source_refused" && SOURCE_REFUSED_DETAILS.has(detail)) return detail;
  if (MODEL_PICTURE_CODES.includes(code)) return modelFailureDetail(code, detail);
  return DETAIL_BY_CODE[code] || "not shown";
}

const utf8 = new TextEncoder();
function cutBytes(text        , max        )         {
  if (utf8.encode(text).length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (utf8.encode(`${out}${ch}…`).length > max) break;
    out += ch;
  }
  return `${out}…`;
}

const clip = (value         )         => String(value).slice(0, TRACE_TEXT_MAX);
const isText = (value         )                  => typeof value === "string" && value.length > 0;

function failure(code        , detail        , seen              )                       {
  return seen ? { ok: false, code, detail, seen } : { ok: false, code, detail };
}

function positiveInt(value         , fallback        )         {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createLiveUiPictureService(opts                             )                       {
  const given = (opts && opts.limits) || {};
  const limits                      = {
    concurrentPerSession: positiveInt(given.concurrentPerSession, LIVEUI_PICTURE_LIMITS.concurrentPerSession),
    holdIdleMs: positiveInt(given.holdIdleMs, LIVEUI_PICTURE_LIMITS.holdIdleMs),
    refetchMinMs: positiveInt(given.refetchMinMs, LIVEUI_PICTURE_LIMITS.refetchMinMs),
    partChars: positiveInt(given.partChars, LIVEUI_PICTURE_LIMITS.partChars),
    sessionBytes: positiveInt(given.sessionBytes, LIVEUI_PICTURE_LIMITS.sessionBytes),
    processBytes: positiveInt(given.processBytes, LIVEUI_PICTURE_LIMITS.processBytes),
    toolRecheckMs: positiveInt(given.toolRecheckMs, LIVEUI_PICTURE_LIMITS.toolRecheckMs),
  };
  const now = typeof opts.now === "function" ? () => opts.now () : () => Date.now();
  const setTimer =
    typeof opts.setTimer === "function"
      ? (fn            , ms        ) => opts.setTimer (fn, ms)
      : (fn            , ms        ) => {
          const handle = setTimeout(fn, ms);
          if (handle && typeof (handle       ).unref === "function") (handle       ).unref();
          return handle;
        };
  const clearTimer =
    typeof opts.clearTimer === "function"
      ? (handle         ) => opts.clearTimer (handle)
      : (handle         ) => clearTimeout(handle       );

  const sessions = new Map                      ();

  let toolTimer          = null;

  function trace(event        , data                         )       {
    if (typeof opts.trace !== "function") return;
    try {
      opts.trace(event, data);
    } catch {

    }
  }

  function traceError(where        , err         )       {
    const message = err && (err       ).message ? String((err       ).message) : String(err);
    trace("liveui_v2_picture_error", { where, message: redactPictureText(message).slice(0, 200) });
  }

  function guard(where        , fn            )       {
    try {
      fn();
    } catch (err) {
      traceError(where, err);
    }
  }

  function send(clientId        , frame                         )       {
    try {
      opts.sendToClient(clientId, frame);
    } catch (err) {
      const message = err && (err       ).message ? String((err       ).message) : String(err);
      trace("liveui_v2_picture_error", { where: "send", message: redactPictureText(message).slice(0, 200) });
    }
  }

  const keyOf = (pic          )                  => ({ sessionKey: pic.sessionKey, surfaceId: pic.surfaceId, id: pic.id });

  function findPic(key                 )                  {
    const session = sessions.get(key.sessionKey);
    const surface = session && session.surfaces.get(key.surfaceId);
    return (surface && surface.pics.get(key.id)) || null;
  }

  const store = createPictureByteStore({
    sessionMaxBytes: limits.sessionBytes,
    processMaxBytes: limits.processBytes,
    onEvict(key) {
      const pic = findPic(key);
      if (pic && pic.status === "ready") pic.status = "idle";
      trace("liveui_v2_picture_evict", { surfaceId: key.surfaceId, id: key.id });
    },
  });

  function ensureSession(sessionKey        )               {
    let session = sessions.get(sessionKey);
    if (!session) {
      session = {
        key: sessionKey,
        surfaces: new Map(),
        queue: [],
        inflight: new Set(),
        lastActivityAt: null,
        settled: true,
        holdTimer: null,
        staged: new Map(),
        prefetchReported: new Map(),
        prefetching: new Set(),
      };
      sessions.set(sessionKey, session);
    }
    return session;
  }

  function maybeDropSession(session              )       {
    if (
      session.surfaces.size === 0 &&
      session.inflight.size === 0 &&
      session.queue.length === 0 &&
      session.holdTimer === null &&

      session.staged.size === 0 &&
      session.prefetching.size === 0 &&
      session.prefetchReported.size === 0 &&
      sessions.get(session.key) === session
    ) {
      sessions.delete(session.key);
    }
  }

  const stagedKey = (surfaceId        , part        )         => `${surfaceId}\u0000${part}`;

  function pruneStaged(session              )       {
    const at = now();
    for (const [key, staged] of session.staged) {
      if (at - staged.at > PICTURE_STAGED_MAX_AGE_MS) session.staged.delete(key);
    }
  }

  function dropSurfaceStaged(session              , surfaceId        )       {
    const prefix = stagedKey(surfaceId, "");
    for (const key of [...session.staged.keys()]) if (key.startsWith(prefix)) session.staged.delete(key);
    for (const key of [...session.prefetchReported.keys()]) if (key.startsWith(prefix)) session.prefetchReported.delete(key);
  }

  function adoptStaged(session              , pic          )       {
    const key = stagedKey(pic.surfaceId, pic.src);
    const staged = session.staged.get(key);
    if (!staged) return;

    if (staged.reach === "wearer" && pic.reach !== "wearer") return;
    session.staged.delete(key);
    if (now() - staged.at > PICTURE_STAGED_MAX_AGE_MS) return;
    pic.hash = staged.hash;
    pic.mime = staged.mime;
    pic.size = staged.bytes.length;
    pic.width = staged.width;
    pic.height = staged.height;
    pic.failedCode = null;
    pic.status = "ready";
    pic.modelSource = staged.modelSource;
    pic.lastResolveAt = staged.at;
    store.put(keyOf(pic), { bytes: staged.bytes, mime: staged.mime, hash: staged.hash, ...(staged.modelSource ? { modelSource: staged.modelSource } : {}) });
    trace("liveui_v2_picture_adopt", { surfaceId: pic.surfaceId, id: pic.id, bytes: pic.size, type: staged.type });
  }

  function healTools(session              , surface              )       {
    const video = opts.video;
    if (!video) return;
    for (const pic of surface.pics.values()) {
      if (pic.status !== "failed" || !pic.toolReason || pic.released) continue;
      if (!video.heal(session.key, pic.src, pic.toolReason)) continue;
      trace("liveui_v2_picture_heal", { surfaceId: pic.surfaceId, id: pic.id, videoReason: pic.toolReason });
      pic.status = "idle";
      pic.failedCode = null;
      pic.toolReason = null;
      pic.lastResolveAt = null;
      surface.reported.delete(pic.id);
      for (const [clientId, ids] of surface.onGlass) if (ids.has(pic.id)) pic.waiters.set(clientId, new Set());
      if (pic.waiters.size > 0 || pic.eager) enqueue(session, pic, true);
    }
  }

  function armToolWatch()       {
    if (toolTimer !== null || !opts.video) return;
    toolTimer = setTimer(() => guard("toolWatch", onToolWatch), limits.toolRecheckMs);
  }

  function onToolWatch()       {
    toolTimer = null;
    let waiting = false;
    for (const session of [...sessions.values()]) {
      for (const surface of session.surfaces.values()) healTools(session, surface);
      if (!isHeld(session)) pump(session);
      for (const surface of session.surfaces.values()) {
        for (const pic of surface.pics.values()) if (pic.status === "failed" && pic.toolReason && !pic.released) waiting = true;
      }
    }
    if (waiting) armToolWatch();
  }

  function isHeld(session              )          {
    return !session.settled && session.lastActivityAt !== null && now() - session.lastActivityAt < limits.holdIdleMs;
  }

  function armHold(session              )       {
    if (session.holdTimer !== null) return;
    const wait = session.lastActivityAt === null ? 0 : Math.max(0, session.lastActivityAt + limits.holdIdleMs - now());
    session.holdTimer = setTimer(() => guard("hold", () => onHoldTimer(session)), wait);
  }

  function onHoldTimer(session              )       {
    session.holdTimer = null;
    if (sessions.get(session.key) !== session || session.settled) return;
    if (isHeld(session)) {
      armHold(session);
      return;
    }
    flushSession(session);
    maybeDropSession(session);
  }

  function flushSession(session              )       {
    for (const surface of session.surfaces.values()) {
      for (const pic of [...surface.pics.values()]) {
        if (pic.waiters.size > 0) deliver(session, pic, null);
      }
    }
  }

  function repin(session              , surface              )       {
    const union = new Set        ();
    for (const ids of surface.onGlass.values()) for (const id of ids) union.add(id);
    store.pinOnGlass(session.key, surface.id, [...union]);
  }

  function dequeue(session              , pic          )       {
    const at = session.queue.indexOf(pic);
    if (at >= 0) session.queue.splice(at, 1);
  }

  function enqueue(session              , pic          , front         )       {
    if (pic.released || pic.status === "resolving" || pic.status === "ready" || pic.status === "failed") return;
    dequeue(session, pic);
    if (front) session.queue.unshift(pic);
    else session.queue.push(pic);
    pic.status = "queued";
  }

  function pump(session              )       {
    while (session.inflight.size < limits.concurrentPerSession && session.queue.length > 0) {
      const pic = session.queue.shift()            ;
      if (pic.released || pic.status !== "queued") continue;
      start(session, pic);
    }
  }

  function start(session              , pic          )       {
    const attempt          = { pic, controller: new AbortController(), startedAt: now() };
    pic.attempt = attempt;
    pic.status = "resolving";
    pic.lastResolveAt = attempt.startedAt;
    session.inflight.add(attempt);
    let pending                               ;
    try {
      pending = Promise.resolve(opts.resolve(pic.src, pic.reach, { sessionKey: session.key, signal: attempt.controller.signal, modelSitesAllowed: pic.modelSitesAllowed }));
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.then(
      (result) => guard("resolve", () => finish(session, attempt, normalizeResult(result))),
      () => guard("resolve", () => finish(session, attempt, failure("picture_fetch_failed", "network"))),
    );
  }

  function normalizeResult(result         )                       {
    const r = result       ;
    if (r && r.ok === true && r.bytes instanceof Uint8Array && r.bytes.length > 0 && isText(r.mime)) {
      if (typeof r.modelImportValid === "function") {

        const provider = r.modelSource && r.modelSource.provider;
        const site = modelSiteProvider(provider) ? modelSiteLabel(provider) : "";
        try { if (!r.modelImportValid()) return failure("model_import_cancelled", site); }
        catch { return failure("model_import_cancelled", site); }
      }
      const bytes = Buffer.isBuffer(r.bytes) ? r.bytes : Buffer.from(r.bytes);
      const copy = isPictureCopy(r.copy) ? { copy: r.copy } : {};
      const modelSource = r.mime === GLASS_MESH_TYPE ? sanitizeModelSource(r.modelSource) : undefined;
      return { ok: true, bytes, mime: r.mime, type: String(r.type || ""), width: Number(r.width) || 0, height: Number(r.height) || 0, ...copy,
        ...(modelSource ? { modelSource } : {}) };
    }
    if (r && r.ok === false && PICTURE_CODES.includes(r.code)) {

      return failure(r.code, typeof r.detail === "string" ? r.detail : "", isPictureSeen(r.seen) ? r.seen : undefined);
    }
    return failure("picture_fetch_failed", "network");
  }

  function finish(session              , attempt         , result                      )       {
    if (!session.inflight.has(attempt)) return;
    session.inflight.delete(attempt);
    const pic = attempt.pic;
    if (pic.attempt === attempt) pic.attempt = null;
    const surface = session.surfaces.get(pic.surfaceId);
    if (pic.released || !surface || surface.pics.get(pic.id) !== pic) {
      pump(session);
      return;
    }
    const described = describePictureSource(pic.src);
    const ms = Math.max(0, now() - attempt.startedAt);
    if (result.ok) {
      const hash = createHash("sha256").update(result.bytes).digest("hex");
      pic.hash = hash;
      pic.mime = result.mime;
      pic.size = result.bytes.length;
      pic.width = result.width;
      pic.height = result.height;
      pic.failedCode = null;
      pic.status = "ready";
      pic.modelSource = result.modelSource;
      trace("liveui_v2_picture_fetch", {
        surfaceId: pic.surfaceId,
        id: pic.id,
        kind: described.kind,
        host: described.host,
        bytes: pic.size,
        type: result.type,
        width: result.width,
        height: result.height,
        ms,
        ...(result.copy ? { copy: result.copy } : {}),
      });
      const value                    = { bytes: result.bytes, mime: result.mime, hash, ...(result.modelSource ? { modelSource: result.modelSource } : {}) };
      store.put(keyOf(pic), value);
      if (pic.waiters.size > 0) deliver(session, pic, value);
    } else {
      pic.status = "failed";
      pic.failedCode = result.code;
      pic.failedSite = modelFailureSite(result.code, result.detail);
      const reason = videoFailReasonOf(result.detail);
      pic.toolReason = isVideoToolReason(reason) ? reason : null;
      if (pic.toolReason) armToolWatch();
      trace("liveui_v2_picture_fetch", {
        surfaceId: pic.surfaceId,
        id: pic.id,
        kind: described.kind,
        host: described.host,
        bytes: 0,
        type: null,
        width: null,
        height: null,
        ms,
        code: result.code,
        ...(result.seen ? { refusedType: result.seen } : {}),
        ...(modelRefusedFormat(result.detail) ? { modelFormat: result.detail } : {}),
        ...(videoFailReasonOf(result.detail) ? { videoReason: videoFailReasonOf(result.detail) } : {}),
      });
      if (!surface.reported.has(pic.id)) {
        surface.reported.add(pic.id);
        const component = redactPictureText(pic.componentId) || pic.id;
        const line = cutBytes(
          `${component}: picture not shown (${pictureFailureDetail(result.code, result.detail)})`,
          PICTURE_DROP_LINE_MAX_BYTES,
        );
        try {
          opts.dropLine(session.key, line);
        } catch (err) {
          trace("liveui_v2_picture_error", { where: "dropLine", message: clip(redactPictureText(String(err))) });
        }
      }
      const waiters = [...pic.waiters.keys()];
      pic.waiters.clear();
      for (const clientId of waiters) send(clientId, failedFrame(pic));
    }
    pump(session);
  }

  function failedFrame(pic          )                          {
    return {
      type: "liveui_picture", surfaceId: pic.surfaceId, id: pic.id, status: "failed", code: pic.failedCode || "picture_fetch_failed",

      ...(pic.failedCode && pic.failedSite ? { site: pic.failedSite } : {}),
    };
  }

  function pendingFrame(pic          )                          {
    return { type: "liveui_picture", surfaceId: pic.surfaceId, id: pic.id, status: "pending" };
  }

  function loopMark(mime               )                  {
    return typeof mime === "string" && LOOP_PICTURE_MIMES.includes(mime.toLowerCase()) ? { loop: true } : {};
  }

  function videoMark(pic          )                                                                                                                                                {
    if (!opts.video || !isVideoSource(pic.src)) return {};

    const audio = opts.video.audioFor(pic.src);
    const subtitles = opts.video.subtitlesFor?.(pic.src);
    const look = videoLookFor(pic.src);
    return {
      video: true,
      ...(opts.video.metadataFor?.(pic.src) || {}),
      ...(audio ? { audioSrc: audio } : {}),
      ...(subtitles ? { subtitleSrc: subtitles } : {}),
      ...(look.fine ? { fine: true          } : {}),
      ...(look.prep ? { prep: true          } : {}),
    };
  }

  function modelMark(mime               )                   {
    return mime === GLASS_MESH_TYPE ? { model: true } : {};
  }

  function sendSame(clientId        , pic          )       {
    const loop = { ...loopMark(pic.mime), ...videoMark(pic), ...modelMark(pic.mime) };
    send(clientId, {
      type: "liveui_picture",
      surfaceId: pic.surfaceId,
      id: pic.id,
      status: "ready",
      hash: pic.hash,
      mime: pic.mime,
      size: pic.size,
      parts: 0,
      ...loop,
      ...(pic.modelSource ? { modelSource: pic.modelSource } : {}),
    });
    trace("liveui_v2_picture_send", { surfaceId: pic.surfaceId, id: pic.id, clientId, parts: 0, bytes: 0, skipped: "have", ...loop });
  }

  function sendParts(clientId        , pic          , value                   , large = false)       {
    const data = value.bytes.toString("base64");
    const parts = Math.max(1, Math.ceil(data.length / limits.partChars));
    const loop = large ? { large: true          } : { ...loopMark(value.mime), ...videoMark(pic), ...modelMark(value.mime) };
    for (let part = 0; part < parts; part++) {
      send(clientId, {
        type: "liveui_picture",
        surfaceId: pic.surfaceId,
        id: pic.id,
        status: "ready",
        hash: value.hash,
        mime: value.mime,
        size: value.bytes.length,
        part,
        parts,
        data: data.slice(part * limits.partChars, (part + 1) * limits.partChars),
        ...loop,
        ...(value.modelSource && !large ? { modelSource: value.modelSource } : {}),
      });
    }
    trace("liveui_v2_picture_send", { surfaceId: pic.surfaceId, id: pic.id, clientId, parts, bytes: value.bytes.length, ...loop });
  }

  function refetchDue(pic          )          {
    return pic.lastResolveAt === null || now() >= pic.lastResolveAt + limits.refetchMinMs;
  }

  function armRefetch(session              , pic          )       {
    if (pic.refetchTimer !== null || pic.lastResolveAt === null) return;
    const wait = Math.max(0, pic.lastResolveAt + limits.refetchMinMs - now());
    trace("liveui_v2_picture_refetch", { surfaceId: pic.surfaceId, id: pic.id, waitMs: wait });
    pic.refetchTimer = setTimer(
      () =>
        guard("refetch", () => {
          pic.refetchTimer = null;
          if (pic.released || pic.waiters.size === 0 || pic.status !== "idle") return;
          enqueue(session, pic, true);
          pump(session);
        }),
      wait,
    );
  }

  function requestRefetch(session              , pic          )       {
    if (pic.status !== "idle") return;
    if (refetchDue(pic)) {
      enqueue(session, pic, true);
      pump(session);
    } else {
      armRefetch(session, pic);
    }
  }

  function deliver(session              , pic          , inHand                          )       {
    if (pic.waiters.size === 0) return;
    if (pic.status === "failed") {
      const waiters = [...pic.waiters.keys()];
      pic.waiters.clear();
      for (const clientId of waiters) send(clientId, failedFrame(pic));
      return;
    }
    if (isHeld(session)) {
      armHold(session);
      return;
    }
    const value = pic.status === "ready" ? store.get(keyOf(pic)) || inHand : inHand;
    if (!value) {
      requestRefetch(session, pic);
      return;
    }
    const waiters = [...pic.waiters.entries()];
    pic.waiters.clear();
    for (const [clientId, have] of waiters) {
      if (have.has(value.hash)) sendSame(clientId, pic);
      else sendParts(clientId, pic, value);
    }
  }

  const largeKeyOf = (pic          )                  => ({ sessionKey: pic.sessionKey, surfaceId: pic.surfaceId, id: `${pic.id}+large` });

  const LARGE_ASPECT_TOLERANCE = 0.02;

  function largeFailedFrame(pic          , code        )                          {
    return { type: "liveui_picture", surfaceId: pic.surfaceId, id: pic.id, status: "failed", code, large: true };
  }

  function largePendingFrame(pic          )                          {
    return { type: "liveui_picture", surfaceId: pic.surfaceId, id: pic.id, status: "pending", large: true };
  }

  function traceLarge(pic          , row                                                                                                           )       {
    trace("liveui_v2_picture_large", {
      surfaceId: pic.surfaceId,
      id: pic.id,
      status: row.status,
      ms: row.ms,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      ...(row.code ? { code: row.code } : {}),
      host: describePictureSource(pic.src).host,
    });
  }

  function stopLarge(pic          )       {
    const large = pic.large;
    if (!large) return;
    if (large.controller) {
      try {
        large.controller.abort();
      } catch {

      }
      large.controller = null;
    }
    if (large.refetchTimer !== null) {
      clearTimer(large.refetchTimer);
      large.refetchTimer = null;
    }
    large.waiters.clear();
    pic.large = null;
    store.release(largeKeyOf(pic));
  }

  function largeFits(pic          , result                      )          {
    if (!result.ok || result.copy || result.model || result.mime === GLASS_MESH_TYPE) return false;
    if (!(result.width > pic.width)) return false;
    if (pic.width > 0 && pic.height > 0) {
      if (!(result.height > 0)) return false;
      const want = pic.width / pic.height;
      const got = result.width / result.height;
      if (Math.abs(got - want) / want > LARGE_ASPECT_TOLERANCE) return false;
    }
    return true;
  }

  function startLarge(session              , surface              , pic          , large            , urls          )       {
    const controller = new AbortController();
    large.status = "fetching";
    large.controller = controller;
    large.startedAt = now();
    large.code = null;
    const stale = () =>
      controller.signal.aborted ||
      pic.released ||
      pic.large !== large ||
      large.controller !== controller ||
      sessions.get(session.key) !== session ||
      session.surfaces.get(surface.id) !== surface ||
      surface.pics.get(pic.id) !== pic;
    const run = async ()                => {
      let lastCode                = null;
      let fetchedAny = false;
      for (const url of urls) {
        let result                      ;
        try {
          result = normalizeResult(await opts.resolve(url, pic.reach, { sessionKey: session.key, signal: controller.signal, modelSitesAllowed: false }));
        } catch {
          result = failure("picture_fetch_failed", "network");
        }
        if (stale()) return;
        if (!result.ok) {
          lastCode = result.code;
          continue;
        }
        fetchedAny = true;
        if (!largeFits(pic, result)) continue;
        const hash = createHash("sha256").update(result.bytes).digest("hex");
        const value                    = { bytes: result.bytes, mime: result.mime, hash };
        large.status = "ready";
        large.controller = null;
        large.hash = hash;
        large.mime = result.mime;
        large.size = result.bytes.length;
        traceLarge(pic, { status: "ready", ms: Math.max(0, now() - large.startedAt), bytes: large.size, width: result.width, height: result.height });
        store.put(largeKeyOf(pic), value);
        const waiters = [...large.waiters];
        large.waiters.clear();
        for (const clientId of waiters) sendParts(clientId, pic, value, true);
        return;
      }
      const code = fetchedAny || !lastCode ? PICTURE_NO_LARGER : lastCode;
      large.status = "failed";
      large.controller = null;
      large.code = code;
      traceLarge(pic, { status: "failed", ms: Math.max(0, now() - large.startedAt), bytes: 0, width: null, height: null, code });
      const waiters = [...large.waiters];
      large.waiters.clear();
      for (const clientId of waiters) send(clientId, largeFailedFrame(pic, code));
    };
    run().catch((err) => traceError("large", err));
  }

  function wantLarge(clientId        , session              , surface              , id        )       {
    const pic = surface.pics.get(id);
    if (!pic) {
      trace("liveui_v2_picture_want_ignored", { surfaceId: clip(surface.id), id: clip(id), clientId: clip(clientId), reason: "unknown_id", large: true });
      return;
    }
    const urls = !pic.hash || pic.mime === GLASS_MESH_TYPE || isVideoSource(pic.src) ? [] : largerCopyUrls(pic.src);
    if (urls.length === 0) {
      traceLarge(pic, { status: "failed", ms: 0, bytes: 0, width: null, height: null, code: PICTURE_NO_LARGER });
      send(clientId, largeFailedFrame(pic, PICTURE_NO_LARGER));
      return;
    }
    let large = pic.large;
    if (large && large.status === "failed") {
      send(clientId, largeFailedFrame(pic, large.code || PICTURE_NO_LARGER));
      return;
    }
    if (large && large.status === "ready") {
      const value = store.get(largeKeyOf(pic));
      if (value) {
        sendParts(clientId, pic, value, true);
        return;
      }

      large.waiters.add(clientId);
      send(clientId, largePendingFrame(pic));
      if (now() >= large.startedAt + limits.refetchMinMs) {
        startLarge(session, surface, pic, large, urls);
      } else if (large.refetchTimer === null) {
        const held = large;
        held.refetchTimer = setTimer(
          () =>
            guard("largeRefetch", () => {
              held.refetchTimer = null;
              if (pic.released || pic.large !== held || held.status !== "ready" || held.waiters.size === 0) return;
              const kept = store.get(largeKeyOf(pic));
              if (kept) {
                const waiters = [...held.waiters];
                held.waiters.clear();
                for (const waiter of waiters) sendParts(waiter, pic, kept, true);
                return;
              }
              startLarge(session, surface, pic, held, urls);
            }),
          Math.max(0, large.startedAt + limits.refetchMinMs - now()),
        );
      }
      return;
    }
    if (large && large.status === "fetching") {
      large.waiters.add(clientId);
      send(clientId, largePendingFrame(pic));
      return;
    }
    large = { status: "fetching", hash: null, mime: null, size: 0, code: null, waiters: new Set([clientId]), controller: null, startedAt: now(), refetchTimer: null };
    pic.large = large;
    send(clientId, largePendingFrame(pic));
    startLarge(session, surface, pic, large, urls);
  }

  function release(session              , surface              , pic          )       {
    pic.released = true;

    stopLarge(pic);
    if (pic.attempt) {
      session.inflight.delete(pic.attempt);
      try {
        pic.attempt.controller.abort();
      } catch {

      }
      pic.attempt = null;
    }
    dequeue(session, pic);
    if (pic.refetchTimer !== null) {
      clearTimer(pic.refetchTimer);
      pic.refetchTimer = null;
    }
    pic.waiters.clear();
    store.release(keyOf(pic));
    surface.pics.delete(pic.id);
    for (const ids of surface.onGlass.values()) ids.delete(pic.id);
  }

  function releaseSurface(session              , surface              )       {
    for (const pic of [...surface.pics.values()]) release(session, surface, pic);
    store.releaseSurface(session.key, surface.id);
    session.surfaces.delete(surface.id);
  }

  function newPic(sessionKey        , surfaceId        , entry                    , reach              , modelSitesAllowed         )           {
    return {
      sessionKey,
      surfaceId,
      id: entry.id,
      src: entry.src,
      componentId: isText(entry.componentId) ? entry.componentId : entry.id,
      reach,
      modelSitesAllowed,
      eager: entry.eager === true,
      status: "idle",
      hash: null,
      mime: null,
      size: 0,
      width: 0,
      height: 0,
      failedCode: null,
      toolReason: null,
      lastResolveAt: null,
      attempt: null,
      waiters: new Map(),
      refetchTimer: null,
      released: false,
      large: null,
    };
  }

  async function prefetchOne(
    sessionKey        ,
    surfaceId        ,
    entry                                      ,
    reach              ,
  )                                 {
    if (!entry || !isText(entry.src)) return { ok: false, code: "picture_source_refused", detail: "source refused" };
    if (!isText(sessionKey) || !isText(surfaceId)) return { ok: false, code: "picture_fetch_failed", detail: "network" };
    const src = entry.src;
    if (classifyPictureSource(src).kind === "asset") return { ok: true };
    const fixedReach               = reach === "wearer" ? "wearer" : "hosts";
    const componentId = isText(entry.componentId) ? entry.componentId : "picture";
    const session = ensureSession(sessionKey);
    pruneStaged(session);
    const controller = new AbortController();
    session.prefetching.add(controller);
    const startedAt = now();
    let result                      ;
    try {
      result = normalizeResult(await opts.resolve(src, fixedReach, { sessionKey, signal: controller.signal }));
    } catch {
      result = failure("picture_fetch_failed", "network");
    }
    session.prefetching.delete(controller);

    const current = sessions.get(sessionKey) === session;
    const described = describePictureSource(src);
    const ms = Math.max(0, now() - startedAt);
    const reportKey = stagedKey(surfaceId, componentId);

    if (result.ok) {
      const hash = createHash("sha256").update(result.bytes).digest("hex");
      trace("liveui_v2_picture_fetch", {
        surfaceId,
        id: null,
        componentId: clip(redactPictureText(componentId)),
        kind: described.kind,
        host: described.host,
        bytes: result.bytes.length,
        type: result.type,
        width: result.width,
        height: result.height,
        ms,
        ...(result.copy ? { copy: result.copy } : {}),
        staged: current,
      });
      if (current) {
        session.prefetchReported.delete(reportKey);
        const key = stagedKey(surfaceId, src);
        session.staged.delete(key);
        session.staged.set(key, { bytes: result.bytes, mime: result.mime, hash, width: result.width, height: result.height, type: result.type, reach: fixedReach, at: now(),
          ...(result.modelSource ? { modelSource: result.modelSource } : {}) });
        while (session.staged.size > PICTURE_STAGED_MAX) {
          const oldest = session.staged.keys().next().value          ;
          session.staged.delete(oldest);
        }
      }
      return { ok: true };
    }
    const detail = pictureFailureDetail(result.code, result.detail);
    trace("liveui_v2_picture_fetch", {
      surfaceId,
      id: null,
      componentId: clip(redactPictureText(componentId)),
      kind: described.kind,
      host: described.host,
      bytes: 0,
      type: null,
      width: null,
      height: null,
      ms,
      code: result.code,
      ...(result.seen ? { refusedType: result.seen } : {}),
      ...(videoFailReasonOf(result.detail) ? { videoReason: videoFailReasonOf(result.detail) } : {}),
      staged: false,
    });
    if (current) {
      let codes = session.prefetchReported.get(reportKey);
      if (!codes) {
        codes = new Set();
        session.prefetchReported.set(reportKey, codes);
      }

      if (!codes.has(result.code)) {
        codes.add(result.code);
        const component = redactPictureText(componentId) || "picture";
        const line = cutBytes(`${component}: picture not shown (${detail})`, PICTURE_DROP_LINE_MAX_BYTES);
        try {
          opts.dropLine(sessionKey, line);
        } catch (err) {
          trace("liveui_v2_picture_error", { where: "dropLine", message: clip(redactPictureText(String(err))) });
        }
      }
      maybeDropSession(session);
    }
    return { ok: false, code: result.code, detail };
  }

  return {
    noteSurface(sessionKey, surfaceId, update) {
      guard("noteSurface", () => {
        if (!isText(sessionKey) || !isText(surfaceId) || !update) return;

        const reach               = update.reach === "wearer" ? "wearer" : "hosts";
        const listed = new Map                            ();
        for (const entry of Array.isArray(update.sources) ? update.sources : []) {
          if (!entry || !isText(entry.id) || !isText(entry.src) || listed.has(entry.id)) continue;
          if (classifyPictureSource(entry.src).kind === "asset") continue;
          listed.set(entry.id, entry);
        }
        let session = sessions.get(sessionKey);
        if (!session && listed.size === 0) return;
        session = ensureSession(sessionKey);
        pruneStaged(session);
        let surface = session.surfaces.get(surfaceId);
        if (!surface) {
          if (listed.size === 0) {
            maybeDropSession(session);
            return;
          }
          surface = { id: surfaceId, pics: new Map(), onGlass: new Map(), reported: new Set() };
          session.surfaces.set(surfaceId, surface);
        }

        for (const pic of [...surface.pics.values()]) {
          const entry = listed.get(pic.id);
          if (!entry || entry.src !== pic.src) release(session, surface, pic);
        }
        for (const entry of listed.values()) {
          let pic = surface.pics.get(entry.id);
          if (!pic) {
            pic = newPic(sessionKey, surfaceId, entry, reach, update.modelSitesAllowed === true);
            surface.pics.set(entry.id, pic);

            adoptStaged(session, pic);
          }
          if (isText(entry.componentId)) pic.componentId = entry.componentId;
          pic.eager = entry.eager === true;
          if (pic.eager && pic.status === "idle" && pic.lastResolveAt === null) enqueue(session, pic, false);
        }
        healTools(session, surface);
        repin(session, surface);
        if (surface.pics.size === 0) session.surfaces.delete(surfaceId);
        pump(session);
        maybeDropSession(session);
      });
    },

    noteSurfaceGone(sessionKey, surfaceId) {
      guard("noteSurfaceGone", () => {
        const session = sessions.get(sessionKey);
        if (!session) return;

        dropSurfaceStaged(session, surfaceId);
        const surface = session.surfaces.get(surfaceId);
        if (surface) {
          releaseSurface(session, surface);
          pump(session);
        }
        maybeDropSession(session);
      });
    },

    prefetch(sessionKey, surfaceId, entry, reach) {

      return prefetchOne(sessionKey, surfaceId, entry, reach).catch((err)                        => {
        traceError("prefetch", err);
        return { ok: false, code: "picture_fetch_failed", detail: pictureFailureDetail("picture_fetch_failed", "") };
      });
    },

    noteRecordActivity(sessionKey) {
      guard("noteRecordActivity", () => {
        if (!isText(sessionKey)) return;
        const session = ensureSession(sessionKey);
        session.lastActivityAt = now();
        session.settled = false;
        armHold(session);
      });
    },

    noteSettled(sessionKey) {
      guard("noteSettled", () => {
        const session = sessions.get(sessionKey);
        if (!session) return;
        session.settled = true;
        if (session.holdTimer !== null) {
          clearTimer(session.holdTimer);
          session.holdTimer = null;
        }
        for (const surface of session.surfaces.values()) healTools(session, surface);
        pump(session);
        flushSession(session);
        maybeDropSession(session);
      });
    },

    want(clientId, sessionKey, msg) {
      guard("want", () => {
        if (!isText(clientId) || !isText(sessionKey) || !msg || !isText(msg.surfaceId)) {
          trace("liveui_v2_picture_want_ignored", { clientId: clip(clientId), reason: "bad_message" });
          return;
        }
        const session = sessions.get(sessionKey);
        const surface = session && session.surfaces.get(msg.surfaceId);
        if (!session || !surface) {
          trace("liveui_v2_picture_want_ignored", { surfaceId: clip(msg.surfaceId), clientId: clip(clientId), reason: "unknown_surface" });
          return;
        }

        if (msg.large === true) {
          const first = Array.isArray(msg.ids) ? msg.ids.find(isText) : undefined;
          wantLarge(clientId, session, surface, first || "");
          return;
        }
        const ids = [...new Set((Array.isArray(msg.ids) ? msg.ids : []).filter(isText))].slice(0, MAX_WANT_IDS);
        const have = new Set((Array.isArray(msg.have) ? msg.have : []).filter(isText).slice(0, MAX_HAVE));
        surface.onGlass.set(clientId, new Set(ids.filter((id) => surface.pics.has(id))));
        repin(session, surface);
        const front             = [];
        const ready             = [];
        for (const id of ids) {
          const pic = surface.pics.get(id);
          if (!pic) {
            trace("liveui_v2_picture_want_ignored", { surfaceId: clip(msg.surfaceId), id: clip(id), clientId: clip(clientId), reason: "unknown_id" });
            continue;
          }
          if (pic.status === "failed") {
            send(clientId, failedFrame(pic));
            continue;
          }
          if (pic.waiters.has(clientId)) {
            trace("liveui_v2_picture_want_ignored", { surfaceId: pic.surfaceId, id: pic.id, clientId: clip(clientId), reason: "already_pending" });
            continue;
          }

          if ((pic.status === "ready" || pic.status === "idle") && pic.hash && have.has(pic.hash)) {
            sendSame(clientId, pic);
            continue;
          }
          send(clientId, pendingFrame(pic));
          pic.waiters.set(clientId, have);
          if (pic.status === "ready") ready.push(pic);
          else if (pic.status === "queued") front.push(pic);
          else if (pic.status === "idle") {
            if (refetchDue(pic)) front.push(pic);
            else armRefetch(session, pic);
          }
        }

        for (let i = front.length - 1; i >= 0; i--) enqueue(session, front[i], true);
        pump(session);
        for (const pic of ready) deliver(session, pic, null);
      });
    },

    refreshVideoMetadata(src) {
      guard("refreshVideoMetadata", () => {
        for (const session of sessions.values()) for (const surface of session.surfaces.values()) {
          for (const pic of surface.pics.values()) {
            if (pic.released || pic.status !== "ready" || !pic.hash || (src && pic.src !== src) || !isVideoSource(pic.src)) continue;
            for (const [clientId, ids] of surface.onGlass) if (ids.has(pic.id)) sendSame(clientId, pic);
          }
        }
      });
    },

    videoWant(clientId, sessionKey, msg) {
      guard("videoWant", () => {
        const video = opts.video;
        if (!video || !isText(clientId) || !isText(sessionKey) || !msg || !isText(msg.surfaceId) || !isText(msg.id)) return;
        const session = sessions.get(sessionKey);
        const surface = session && session.surfaces.get(msg.surfaceId);
        const pic = surface && surface.pics.get(msg.id);
        const n = Number.isInteger(msg.n) && msg.n >= 0 ? msg.n : 0;
        const t = typeof msg.t === "number" && Number.isFinite(msg.t) && msg.t >= 0 ? msg.t : 0;
        const head = { type: "liveui_video_frame", surfaceId: msg.surfaceId, id: msg.id, n, t };
        if (!pic || !video.isVideo(pic.src)) {
          send(clientId, { ...head, end: true, code: "video_unknown" });
          return;
        }
        const url = video.sourceUrl(pic.src, pic.reach, typeof opts.videoHostCheck === "function" ? opts.videoHostCheck() : null);
        if (!url) {
          send(clientId, { ...head, end: true, code: "video_refused" });
          return;
        }
        const started = now();
        const src = pic.src;
        video.frame(sessionKey, pic.src, url, t, msg.seek === true ? { seek: true } : undefined).then(
          (frame) => {
            if (sessions.get(sessionKey) !== session || session.surfaces.get(msg.surfaceId) !== surface || surface.pics.get(msg.id) !== pic || pic.src !== src) return;
            if (frame.ok) {
              send(clientId, { ...head, at: frame.at, w: frame.w, h: frame.h, data: frame.data, end: false, ...(frame.raw ? { raw: true } : {}) });
              trace("liveui_v2_video_send", { surfaceId: msg.surfaceId, id: msg.id, n, t, at: frame.at, look: frame.look, ms: now() - started });
            } else {

              send(clientId, { ...head, end: frame.end, ...(frame.code ? { code: frame.code } : {}) });
              trace("liveui_v2_video_send", { surfaceId: msg.surfaceId, id: msg.id, n, t, end: frame.end, code: frame.code || null });
            }
          },
          (err) => traceError("videoWant", err),
        );
      });
    },

    noteClientGone(clientId) {
      guard("noteClientGone", () => {
        for (const session of sessions.values()) {
          for (const surface of session.surfaces.values()) {
            for (const pic of surface.pics.values()) {
              pic.waiters.delete(clientId);
              if (pic.large) pic.large.waiters.delete(clientId);
            }
            if (surface.onGlass.delete(clientId)) repin(session, surface);
          }
        }
      });
    },

    clearSession(sessionKey) {
      guard("clearSession", () => {
        if (opts.video) opts.video.dropSession(sessionKey);
        const session = sessions.get(sessionKey);
        if (!session) return;
        for (const surface of [...session.surfaces.values()]) releaseSurface(session, surface);
        for (const attempt of [...session.inflight]) {
          try {
            attempt.controller.abort();
          } catch {

          }
        }
        session.inflight.clear();
        session.queue.length = 0;
        for (const controller of [...session.prefetching]) {
          try {
            controller.abort();
          } catch {

          }
        }
        session.prefetching.clear();
        session.staged.clear();
        session.prefetchReported.clear();
        if (session.holdTimer !== null) {
          clearTimer(session.holdTimer);
          session.holdTimer = null;
        }
        store.releaseSession(sessionKey);
        sessions.delete(sessionKey);
      });
    },

    stats() {
      try {
        let surfaces = 0;
        let pictures = 0;
        let waiters = 0;
        let queued = 0;
        let inflight = 0;
        let staged = 0;
        const byStatus                         = {};
        for (const session of sessions.values()) {
          surfaces += session.surfaces.size;
          queued += session.queue.length;
          inflight += session.inflight.size;
          staged += session.staged.size;
          for (const surface of session.surfaces.values()) {
            for (const pic of surface.pics.values()) {
              pictures += 1;
              waiters += pic.waiters.size;
              byStatus[pic.status] = (byStatus[pic.status] || 0) + 1;
            }
          }
        }
        return { sessions: sessions.size, surfaces, pictures, queued, inflight, staged, waiters, byStatus, limits: { ...limits }, store: store.stats() };
      } catch {
        return {};
      }
    },
  };
}

function laneWait(ticket                 , signal                         )                {
  if (!signal) return ticket.wait();
  if (signal.aborted) return Promise.reject(new Error("cancelled"));
  return new Promise      ((resolve, reject) => {
    const onAbort = () => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    ticket.wait().then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function createPictureResolver(deps                     )                                         {
  const models = deps.models;
  const lane = deps.modelLane || MODEL_LANE;
  const toMesh = async (result                      , signal                         ) =>
    models ? models.convert(result, { trace: deps.trace, signal }) : result;
  return async (src, reach, ctx) => {
    const source = classifyPictureSource(src);
    try {
      if (source.kind === "url" && deps.video && deps.video.isVideo(src)) {
        if (deps.httpEnabled() !== true) return failure("picture_source_refused", "source refused");
        const url = deps.video.sourceUrl(src, reach, deps.hostCheck());
        if (!url) return failure("picture_host_refused", "host refused");
        const poster = await deps.video.poster(ctx.sessionKey, src, url);
        if (!poster) {

          const reason = deps.video.failReason(ctx.sessionKey, src);
          return failure("picture_fetch_failed", reason ? VIDEO_FAIL_DETAIL[reason] : "network");
        }
        return { ok: true, bytes: poster, mime: "image/png", type: "png", width: 288, height: 144 };
      }
      if (source.kind === "url") {

        const ticket = models ? lane.ticket() : null;
        try {
          const fetchOpts = {
            reach,
            httpEnabled: deps.httpEnabled() === true,
            hostCheck: deps.hostCheck(),
            fetch: deps.fetch,
            dispatcher: deps.dispatcher,
            signal: ctx && ctx.signal,
            models,
            modelGate: ticket ? () => ticket.wait() : undefined,
          };
          if (models && deps.modelSites) {
            const imported = await deps.modelSites.resolve(source.url.toString(), {
              reach, allowed: ctx?.modelSitesAllowed === true, signal: ctx?.signal,
            }, async (url, signal) => toMesh(await fetchPictureUrl(url, { ...fetchOpts, signal, model: true }), signal));
            if (imported) return imported;
          }

          const page = models ? await resolvePicturePage(source.url.toString(), fetchOpts) : null;
          if (page && !page.ok) return page;
          const fetched = await fetchPictureUrl(page ? page.url : source.url.toString(), {
            ...fetchOpts,
            model: page ? page.model : false,
            lfsUrl: page && page.lfs ? page.lfs : undefined,
          });
          return await toMesh(fetched, ctx && ctx.signal);
        } finally {
          if (ticket) ticket.release();
        }
      }
      if (source.kind === "file") {
        if (reach !== "wearer") return failure("picture_source_refused", "file pictures need a wearer's run");

        const ticket = models ? lane.ticket() : null;
        try {
          const read = await readPictureFile(source.path, {
            roots: deps.roots(),
            filesAllowed: deps.filesAllowed() === true,
            models,
            modelGate: ticket ? () => laneWait(ticket, ctx && ctx.signal) : undefined,
          });
          const mesh = await toMesh(read, ctx && ctx.signal);
          return mesh.ok || !MODEL_PICTURE_CODES.includes(mesh.code) ? mesh : failure("picture_unreadable", "unreadable");
        } finally {
          if (ticket) ticket.release();
        }
      }
      if (source.kind === "bytes") {
        const decoded = decodePictureDataUrl(source.dataUrl);
        if (!decoded.ok) return failure(decoded.code, pictureFailureDetail(decoded.code, ""));
        const sniff = sniffPicture(decoded.bytes);
        if (!sniff.ok) {
          const model = models && sniff.code === "picture_type_unsupported" ? models.sourceOf(decoded.bytes) : null;
          if (model) return await toMesh(model, ctx && ctx.signal);
          const seen = sniff.code === "picture_type_unsupported" ? pictureLooksLike(decoded.bytes) : undefined;
          return failure(sniff.code, pictureFailureDetail(sniff.code, ""), seen);
        }
        return { ok: true, bytes: decoded.bytes, mime: sniff.mime, type: sniff.type, width: sniff.width, height: sniff.height };
      }
      return failure("picture_source_refused", "source refused");
    } catch {
      return source.kind === "file"
        ? failure("picture_unreadable", "unreadable")
        : failure("picture_fetch_failed", "network");
    }
  };
}

module.exports = { LOOP_PICTURE_MIMES, LIVEUI_PICTURE_LIMITS, PICTURE_DROP_LINE_MAX_BYTES, PICTURE_STAGED_MAX_AGE_MS, PICTURE_STAGED_MAX, PICTURE_NO_LARGER, PICTURE_CODES, pictureFailureDetail, createLiveUiPictureService, createPictureResolver };
