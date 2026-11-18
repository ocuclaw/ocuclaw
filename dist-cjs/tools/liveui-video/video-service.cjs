const { Buffer } = require("node:buffer");
const { createHash, randomBytes } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");
const { VIDEO_H, VIDEO_W, boxedPoster, newVideoLookState, packLevels, renderVideoFrame, sharpness, canGoBusy, videoFrameSize, videoLookFor } = require("./video-look.cjs");
const { createVideoResolver, currentVideoProxy, videoSourceKind } = require("./video-source.cjs");
const { videoPageReason, videoReadReason } = require("./video-failure.cjs");
const { MEDIA_BINARY_NAME, mediaBinary, mediaBinaryFound } = require("./media-binaries.cjs");
const { startHostProcess } = require("../host-process.cjs");
const { fetchMedia, readMediaBody } = require("./media-fetch.cjs");
const { createMediaRelay } = require("./media-relay.cjs");
const { mediaEnv } = require("./media-process.cjs");
const { createVideoSubtitles, selectVideoSubtitleTracks } = require("./video-subtitles.cjs");

const DECODE_FPS = 12;
const FRAME_BYTES = VIDEO_W * VIDEO_H;

const AHEAD_MAX_S = 8;

const BEHIND_KEEP_S = 4;

const PICK_WINDOW_S = 0.25;

const FINE_PICK_WINDOW_S = 1 / 6;

const SKIP_SLACK_S = 0.01;

function skipOffset(t        )         {
  return Math.floor(t * DECODE_FPS + 1e-6) / DECODE_FPS;
}
const WAIT_FRAME_MS = 4000;
const POSTER_WAIT_MS = 12000;
const IDLE_KILL_MS = 45000;
const MAX_DECODERS = 2;
const RANGE_PROBE_MS = 3000;
const MAX_METADATA = 64;
const PROTOCOLS = "http,tcp";

const RESOLVE_WAIT_MS = 35000;

const START_LIMIT_MS = RESOLVE_WAIT_MS + POSTER_WAIT_MS;

const LIVEUI_AUDIO_PATH = "/_ocuclaw/liveui/audio/v1";

const LIVEUI_SUBTITLES_PATH = "/_ocuclaw/liveui/subtitles/v1";
const LIVEUI_SUBTITLE_PAGE_BYTES = 240 * 1024;
const LIVEUI_SUBTITLE_TRACK_BYTES = 1024 * 1024;
const MAX_SUBTITLE_TOKENS = 64;
const SUBTITLE_LANGUAGES = ["en", "ja", "ko", "zh-CN", "zh-TW"]         ;

const AUDIO_CHUNK_BYTES = 240 * 1024;
const MAX_AUDIO_TOKENS = 64;

const MAX_WHOLE_AUDIO = 4;
const MAX_WHOLE_AUDIO_BYTES = 48 * 1024 * 1024;

const TOOLS_NOTE_EVERY_MS = 10 * 60 * 1000;

function plainResponse(statusCode        , text        )                      {
  return { statusCode, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: Buffer.from(text) };
}

function normalizeLiveUiSubtitleLanguage(value         )                {
  if (value === undefined || value === null) return "en";
  if (typeof value !== "string") return null;
  const language = value.toLowerCase().replace(/_/g, "-");
  return ({ en: "en", ja: "ja", ko: "ko", "zh-cn": "zh-CN", "zh-tw": "zh-TW", "zh-hans": "zh-CN", "zh-hant": "zh-TW" }                          )[language] || null;
}

function normalizeLiveUiSubtitleKind(value         )                                    {
  if (value === undefined || value === null || value === "auto") return "auto";
  return value === "creator" || value === "automatic" ? value : null;
}

function subtitleResponse(statusCode        , value         )                      {
  const body = Buffer.from(JSON.stringify(value));
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store",
      "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS",
    },
    body,
  };
}

function parseRange(range         )                                               {
  if (range === undefined || range === null || range === "") return { start: 0, end: null };
  const m = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(String(range).trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : null;
  return end !== null && end < start ? null : { start, end };
}

function videoDuration(text        )                {
  const m = /Duration:\s*(\d{1,3}):([0-5]\d):([0-5]\d(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function isVideoSource(src        )          {
  return videoSourceKind(src) !== null;
}

function createLiveUiVideoService(opts                            = {})                     {

  const ffmpeg = ()         => mediaBinary("ffmpeg", opts.ffmpeg);
  const spawn = opts.spawn || startHostProcess;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const toolsNoted = new Map                ();

  function noteTools(known               , update         )       {
    if (typeof opts.onToolsNeeded !== "function") return;
    const all                = ["ffmpeg", "ytdlp"];
    const programs                              = { ffmpeg: ffmpeg(), ytdlp: mediaBinary("ytdlp") };
    const missing = all.filter((b) => known.includes(b) || !mediaBinaryFound(programs[b])).map((b) => MEDIA_BINARY_NAME[b]);
    if (!missing.length && !update) return;
    const key = `${missing.join(",")}|${update}`;
    const t = now();
    const last = toolsNoted.get(key);
    if (last !== undefined && t - last < TOOLS_NOTE_EVERY_MS) return;
    toolsNoted.set(key, t);
    trace("liveui_v2_video_tools", { missing, update });
    try {
      opts.onToolsNeeded({ missing, update });
    } catch {

    }
  }
  const speedOn = () => {
    try {
      return typeof opts.speed !== "function" || opts.speed() !== false;
    } catch {
      return true;
    }
  };
  const sizeNow = ()                => {
    try {
      const w = typeof opts.size === "function" ? opts.size() : null;
      return typeof w === "number" && Number.isFinite(w) ? w : null;
    } catch {
      return null;
    }
  };

  const lookOf = (d         )            => {
    const width = sizeNow();
    if (width !== d.lookWidth) {
      d.look = videoLookFor(d.src, width);
      d.lookWidth = width;
    }
    return d.look;
  };
  const decoders = new Map                 ();
  let decoderGeneration = 0;
  let pages                       = opts.resolver || null;

  const seekNeeded = new Set        ();
  const fetchAudio                                                                 =
    typeof opts.fetch === "function" ? opts.fetch : fetchMedia;
  const metadata = new Map                                                                                                                                                     ();

  function metadataEntry(url        ) {
    let entry = metadata.get(url);
    if (!entry) {
      if (metadata.size >= MAX_METADATA) metadata.delete(metadata.keys().next().value          );
      entry = { value: { seekable: false }, ranged: false, probing: false, pipe: false };
      metadata.set(url, entry);
    }
    return entry;
  }

  function metadataChanged(url        , patch                        )       {
    const entry = metadataEntry(url);
    const before = JSON.stringify(entry.value);
    entry.value = { ...entry.value, ...patch };
    entry.value.seekable = !entry.pipe && (entry.ranged || entry.hlsIndexed === true) && entry.value.live !== true && (entry.value.durationSec || 0) > 0;
    if (JSON.stringify(entry.value) !== before) {
      trace("liveui_v2_video_metadata", entry.value                                      );
      try { opts.onMetadata?.(); } catch {  }
    }
  }

  function probeRange(d         , page                                             )       {
    const entry = metadataEntry(d.url);
    if (entry.probing || entry.ranged || entry.probeGeneration === d.generation || entry.pipe || entry.value.live || !entry.value.durationSec) return;
    const input = page ? page.video.url : d.url;
    if (!/^https?:/.test(input) || (page ? /^m3u8/.test(page.video.protocol) : /\.m3u8(?:$|\?)/i.test(input))) return;
    entry.probing = true;
    entry.probeGeneration = d.generation;
    const abort = new AbortController();
    const sameProbe = () => metadata.get(d.url) === entry && entry.probeGeneration === d.generation && (!page || entry.stream === input);
    const release = () => { if (sameProbe()) entry.probing = false; };
    const deadline = setTimeout(() => { abort.abort(); release(); }, RANGE_PROBE_MS);
    const fetchRange = opts.fetch || fetchMedia;
    Promise.resolve().then(() => fetchRange(input, { ...(page ? page.video.headers : {}), Range: "bytes=0-0" }, abort.signal)).then(
      (response) => {
        const range = String(response.headers?.get("content-range") || "");
        if (!abort.signal.aborted && sameProbe()) {
          entry.ranged = response.status === 206 && /^bytes 0-0\/[1-9]\d*$/.test(range);
          metadataChanged(d.url, {});
        }

        try { Promise.resolve(response.body?.cancel()).catch(() => undefined); } catch {  }
      },
      () => undefined,
    ).finally(() => { clearTimeout(deadline); release(); });
  }

  const audioTokens = new Map                ();
  const tokenOfPage = new Map                ();

  const subtitleTokens = new Map                ();
  const subtitleTokenOfPage = new Map                ();
  let subtitleLoader                        = opts.subtitleLoader || null;

  const subtitleTracks = new WeakMap                                                                              ();

  function subtitleToken(page        )         {
    const have = subtitleTokenOfPage.get(page);
    if (have) return have;
    while (subtitleTokens.size >= MAX_SUBTITLE_TOKENS) {
      const first = subtitleTokens.keys().next().value          ;
      subtitleTokenOfPage.delete(subtitleTokens.get(first)          );
      subtitleTokens.delete(first);
    }
    const token = randomBytes(24).toString("hex");
    subtitleTokens.set(token, page);
    subtitleTokenOfPage.set(page, token);
    return token;
  }

  function subtitleTrack(track               ) {
    const have = subtitleTracks.get(track);
    if (have) return have;
    const normalized = JSON.stringify({ language: track.language, kind: track.kind, cues: track.cues });
    const prefixBytes = [0];
    for (const cue of track.cues) prefixBytes.push(prefixBytes[prefixBytes.length - 1] + Buffer.byteLength(JSON.stringify(cue)));
    const entry = {
      trackId: createHash("sha256").update(normalized).digest("hex"), prefixBytes,
      tooLarge: track.cues.length > 4000 || Buffer.byteLength(normalized) > LIVEUI_SUBTITLE_TRACK_BYTES,
    };
    subtitleTracks.set(track, entry);
    return entry;
  }

  function audioToken(page                                      )         {
    const have = tokenOfPage.get(page.page);
    if (have) return have;
    if (audioTokens.size >= MAX_AUDIO_TOKENS) {
      const oldest = audioTokens.keys().next().value          ;
      tokenOfPage.delete(audioTokens.get(oldest)          );
      audioTokens.delete(oldest);
    }
    const token = randomBytes(18).toString("base64url");
    audioTokens.set(token, page.page);
    tokenOfPage.set(page.page, token);
    return token;
  }

  const wholeAudio = new Map                                                                                   ();

  function loadWholeAudio(resolved                                      )                                                 {
    const have = wholeAudio.get(resolved.page);
    if (have && have.link === resolved.audio) return have.promise;
    if (wholeAudio.size >= MAX_WHOLE_AUDIO) wholeAudio.delete(wholeAudio.keys().next().value          );
    const link = resolved.audio          ;
    const promise = (async () => {
      try {
        const upstream = await fetchAudio(link, { ...(resolved.audioHeaders || {}), Range: "bytes=0-" });
        if (upstream.status !== 200 && upstream.status !== 206) {
          await upstream.body?.cancel();
          trace("liveui_v2_video_audio", { ok: false, phase: "whole", status: upstream.status });
          return null;
        }
        const length = Number(upstream.headers.get("content-length"));
        const total = Number(String(upstream.headers.get("content-range") || "").split("/")[1]);
        if ((Number.isFinite(length) && length > MAX_WHOLE_AUDIO_BYTES) || (Number.isFinite(total) && total > MAX_WHOLE_AUDIO_BYTES)) {
          if (upstream.body && typeof upstream.body.cancel === "function") upstream.body.cancel().catch(() => {});
          trace("liveui_v2_video_audio", { ok: false, phase: "whole", reason: "too_big", bytes: Number.isFinite(total) ? total : length });
          return null;
        }
        const body = await readMediaBody(upstream, MAX_WHOLE_AUDIO_BYTES);
        if (Number.isFinite(total) && total > 0 && body.length !== total) {
          trace("liveui_v2_video_audio", { ok: false, phase: "whole", reason: "short", bytes: body.length, total });
          return null;
        }
        trace("liveui_v2_video_audio", { ok: true, phase: "whole", bytes: body.length });
        return { body, type: upstream.headers.get("content-type") || "audio/mp4" };
      } catch (err     ) {
        trace("liveui_v2_video_audio", { ok: false, phase: "whole", error: String((err && err.message) || err).slice(0, 120) });
        return null;
      }
    })();
    wholeAudio.set(resolved.page, { link, promise });
    return promise;
  }

  function trace(event        , data                         )       {
    try {
      if (typeof opts.trace === "function") opts.trace(event, data);
    } catch {

    }
  }

  function notify(d         )       {

    const wakes = [...d.waiters];
    d.waiters.clear();
    for (const wake of wakes) wake();
  }

  function kill(d         , reason        )       {
    if (decoders.get(d.key) !== d) return;
    d.abort.abort();
    void d.relay?.close();
    d.relay = null;
    if (d.idleTimer) clearTimeout(d.idleTimer);
    decoders.delete(d.key);
    try {
      if (d.child && d.child.exitCode === null) d.child.kill("SIGKILL");
      if (d.feeder && d.feeder.exitCode === null) d.feeder.kill("SIGKILL");
    } catch {

    }
    d.ended = true;
    notify(d);
    trace("liveui_v2_video_decoder", { phase: "stopped", reason, decoded: d.decoded });
  }

  function touch(d         )       {
    d.usedAt = now();
    if (d.idleTimer) clearTimeout(d.idleTimer);
    d.idleTimer = setTimeout(() => kill(d, "idle"), opts.idleKillMs ?? IDLE_KILL_MS);
    if (d.idleTimer && typeof d.idleTimer.unref === "function") d.idleTimer.unref();
  }

  function newest(d         )         {
    return d.frames.length ? d.frames[d.frames.length - 1].at : -1;
  }

  function steer(d         )       {
    const stdout = d.child && d.child.stdout;
    if (!stdout) return;
    const ahead = newest(d) - d.wantAt;
    if (!d.paused && ahead > AHEAD_MAX_S) {
      stdout.pause();
      d.paused = true;
    } else if (d.paused && ahead < AHEAD_MAX_S / 2) {
      stdout.resume();
      d.paused = false;
    }
  }

  function missingTool(err     )          {
    return Boolean(err && (err.code === "ENOENT" || err.code === "EACCES"));
  }

  function start(sessionKey        , src        , url        , offset = 0)          {
    const key = `${sessionKey}|${src}`;
    const have = decoders.get(key);
    if (have) {
      touch(have);
      return have;
    }
    while (decoders.size >= MAX_DECODERS) {
      const oldest = [...decoders.values()].sort((a, b) => a.usedAt - b.usedAt)[0];
      kill(oldest, "evicted");
    }
    const width = sizeNow();
    const d          = {
      key,
      generation: ++decoderGeneration,
      url,
      src,
      look: videoLookFor(src, width),
      lookWidth: width,
      state: newVideoLookState(),
      frames: [],
      decoded: 0,
      offset,
      epoch: 0,
      ended: false,
      error: null,
      reason: null,
      child: null,
      feeder: null,
      abort: new AbortController(),
      relay: null,
      ready: Promise.resolve(),
      live: false,
      waiters: new Set(),
      wantAt: offset,
      paused: false,
      usedAt: now(),
      startedAt: now(),
      idleTimer: null,
    };
    decoders.set(key, d);
    metadataEntry(url);
    touch(d);
    if (videoSourceKind(src) !== "page") {
      d.ready = decode(d, null);
      return d;
    }

    d.ready = resolver()
      .resolve(url)
      .then((page) => {
        if (decoders.get(key) !== d || d.ended) return;
        if (!page.ok) {
          d.error = page.code;
          d.reason = videoPageReason(page);
          d.ended = true;
          trace("liveui_v2_video_decoder", { phase: "failed", error: page.code, detail: page.error, videoReason: d.reason });
          if (page.code === "video_needs_ytdlp") noteTools(["ytdlp"], false);
          else if (page.ytdlpStale) noteTools([], true);
          notify(d);
          return;
        }
        d.live = page.live;
        metadataEntry(url).pipe = page.pipe;
        metadataChanged(url, { ...(page.duration !== null && page.duration > 0 ? { durationSec: page.duration } : {}), live: page.live });
        return decode(d, page);
      })
      .catch((err     ) => {
        if (decoders.get(key) !== d) return;
        d.error = String((err && err.message) || err).slice(0, 200);
        d.reason = "read_failed";
        d.ended = true;
        notify(d);
      });
    return d;
  }

  async function decode(d         , page                                             )                {
    if (page) {
      const entry = metadataEntry(d.url);
      if (entry.stream !== page.video.url) {
        entry.ranged = false;
        entry.hlsIndexed = false;
        entry.probing = false;
        entry.probeGeneration = undefined;
        entry.stream = page.video.url;
      }
      entry.pipe = page.pipe;
      metadataChanged(d.url, { live: page.live });
    }
    let feeder      = null;
    if (page && page.pipe) {
      try {
        feeder = await resolver().pipe(page, d.abort.signal);
      } catch (err     ) {
        if (decoders.get(d.key) !== d || d.abort.signal.aborted) return;
        d.error = String((err && err.message) || err).slice(0, 200);
        d.reason = "read_failed";
        d.ended = true;
        trace("liveui_v2_video_decoder", { phase: "failed", error: d.error });
        notify(d);
        return;
      }
      if (decoders.get(d.key) !== d || d.ended || d.abort.signal.aborted) {
        feeder.kill("SIGKILL");
        return;
      }
      d.feeder = feeder;
    }
    const sourceInput = feeder ? "pipe:0" : page ? page.video.url : d.url;

    if (d.live) d.offset = d.wantAt;

    const skip = !d.live && d.offset > 0 && (feeder !== null || (page !== null && !metadataEntry(d.url).value.seekable));
    if (skip) d.offset = skipOffset(d.offset);
    const http = /^https?:/i.test(sourceInput);
    const hls = page ? /^m3u8/.test(page.video.protocol) : /\.m3u8$/i.test(new URL(sourceInput, "http://x").pathname);
    let relay                    = null;
    if (http) {
      try {
        relay = await createMediaRelay(sourceInput, {
          headers: page?.video.headers,
          ...(page ? { proxy: currentVideoProxy() } : {}), signal: d.abort.signal, hls,
        });
      } catch (err     ) {
        if (decoders.get(d.key) !== d || d.abort.signal.aborted) return;
        d.error = String((err && err.message) || err).slice(0, 200); d.reason = "read_failed"; d.ended = true; notify(d); return;
      }
      if (decoders.get(d.key) !== d || d.ended || d.abort.signal.aborted) { await relay.close(); return; }
      d.relay = relay;
    }
    const input = relay ? relay.url : sourceInput;

    const linear = http && !hls && !page && d.offset === 0 && !seekNeeded.has(sourceInput);
    const args = [
      "-hide_banner", "-loglevel", "info", "-nostats", "-nostdin",
      "-protocol_whitelist", feeder ? "pipe" : hls ? `${PROTOCOLS},hls,crypto` : PROTOCOLS,
      "-format_whitelist", hls ? "mov,matroska,mpegts,hls" : "mov,matroska,mpegts",

      ...(http ? ["-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_delay_max", "4"] : []),
      ...(linear ? ["-seekable", "0"] : []),
      ...(d.offset > 0 && !skip && !d.live ? ["-ss", String(d.offset)] : []),
      "-i", input,

      ...(skip ? ["-ss", (d.offset - SKIP_SLACK_S).toFixed(3)] : []),
      "-an", "-sn",
      "-vf", `fps=${DECODE_FPS},scale=${VIDEO_W}:${VIDEO_H}:force_original_aspect_ratio=increase:flags=area,crop=${VIDEO_W}:${VIDEO_H},format=gray`,
      "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
    ];
    let child     ;
    try {
      child = spawn(ffmpeg(), args, { stdio: [feeder ? "pipe" : "ignore", "pipe", "pipe"], env: mediaEnv() });
    } catch (err     ) {
      await relay?.close();
      if (d.relay === relay) d.relay = null;
      d.error = String((err && err.message) || err).slice(0, 200);
      d.reason = missingTool(err) ? "ffmpeg_missing" : "read_failed";
      d.ended = true;
      if (feeder && feeder.exitCode === null) feeder.kill("SIGKILL");
      trace("liveui_v2_video_decoder", { phase: "failed", error: d.error });
      notify(d);
      return;
    }
    d.child = child;
    const active = () => decoders.get(d.key) === d && d.child === child;
    probeRange(d, page);
    if (feeder) {

      child.stdin.on("error", () => undefined);
      feeder.stdout.on("error", () => undefined);
      feeder.stdout.pipe(child.stdin);
      feeder.on("error", (err     ) => {
        if (!active()) return;
        if (!d.error) d.error = String((err && err.message) || err).slice(0, 200);
      });

      feeder.stderr.on("data", (chunk        ) => {
        if (!active()) return;
        const line = chunk.toString("utf8").split("\n").filter((l        ) => /ERROR/.test(l)).pop();
        if (line && !d.error) d.error = line.slice(0, 200);
      });
    }
    trace("liveui_v2_video_decoder", {
      phase: "started",
      look: d.look.name,
      offset: d.offset,
      ...(skip ? { skip: true } : {}),
      ...(page ? { source: "page", extractor: page.extractor, format: page.video.formatId, pipe: Boolean(feeder), live: page.live } : {}),
    });
    let pending = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk        ) => {
      if (!active()) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= FRAME_BYTES) {
        const gray = new Uint8Array(pending.subarray(offset, offset + FRAME_BYTES));
        offset += FRAME_BYTES;
        d.frames.push({ at: d.offset + d.decoded / DECODE_FPS, gray, sharp: sharpness(gray) });
        d.decoded++;
      }
      pending = offset ? Buffer.from(pending.subarray(offset)) : pending;
      const keepFrom = d.wantAt - BEHIND_KEEP_S;
      while (d.frames.length > 1 && d.frames[0].at < keepFrom) d.frames.shift();
      steer(d);
      notify(d);
    });
    child.stderr.on("data", (chunk        ) => {
      if (!active()) return;
      if (stderr.length < 2000) stderr += chunk.toString("utf8");
      const duration = videoDuration(stderr);
      if (duration !== null) {

        if (hls && !feeder && !d.live) metadataEntry(d.url).hlsIndexed = true;
        metadataChanged(d.url, { durationSec: duration, ...(!page || (hls && !d.live) ? { live: false } : {}) });
        probeRange(d, page);
      }
    });
    child.on("error", (err     ) => {
      void relay?.close();
      if (d.relay === relay) d.relay = null;
      if (!active()) return;
      d.error = String((err && err.message) || err).slice(0, 200);
      d.reason = missingTool(err) ? "ffmpeg_missing" : "read_failed";
      d.ended = true;
      if (missingTool(err)) noteTools(["ffmpeg"], false);
      notify(d);
    });
    child.on("close", (code               ) => {
      void relay?.close();
      if (d.relay === relay) d.relay = null;
      if (!active()) return;
      if (feeder && feeder.exitCode === null) feeder.kill("SIGKILL");
      if (linear && code && d.decoded === 0 && !d.ended && decoders.get(d.key) === d && !/Server returned [45]\d\d/.test(stderr)) {
        if (seekNeeded.size >= 200) seekNeeded.clear();
        seekNeeded.add(sourceInput);
        trace("liveui_v2_video_decoder", { phase: "reopen", reason: "needs_seek" });
        d.ready = decode(d, page);
        return;
      }

      const refused = /Server returned 40[34]|HTTP Error 40[34]/.test(`${stderr}\n${d.error || ""}`);
      if (page && refused && code && d.decoded === 0 && !d.ended && decoders.get(d.key) === d) {
        const next = resolver().fallback(page);
        if (next) {
          trace("liveui_v2_video_decoder", { phase: "reopen", reason: "refused", format: next.video.formatId });
          d.error = null;
          d.feeder = null;
          d.ready = decode(d, next);
          return;
        }
      }
      d.ended = true;

      if (code && !d.error) d.error = stderr.trim().split("\n").slice(-1)[0]?.replace(/^\S+:\/\/\S+?: /, "").slice(0, 200) || `exit ${code}`;

      if (code && !d.decoded && !d.reason) d.reason = page ? videoReadReason(d.error || "") : "read_failed";
      trace("liveui_v2_video_decoder", { phase: "ended", code, decoded: d.decoded, error: d.error, ...(d.reason ? { videoReason: d.reason } : {}) });
      notify(d);
    });
  }

  const titleWaits = new Set        ();

  function resolver()                {
    if (!pages) pages = opts.resolver || createVideoResolver({ trace: opts.trace });
    return pages;
  }

  function waitFor(d         , ready               , ms        )                {
    if (ready() || d.ended) return Promise.resolve();
    return new Promise((resolve) => {
      const deadline = setTimeout(done, ms);
      function done() {
        clearTimeout(deadline);
        d.waiters.delete(check);
        resolve();
      }
      function check() {
        if (ready() || d.ended) done();
        else d.waiters.add(check);
      }
      d.waiters.add(check);
    });
  }

  return {
    isVideo: isVideoSource,

    metadataFor(src) {
      try {
        const url = new URL(src);
        url.hash = "";
        const value = metadata.get(url.toString())?.value;
        return value ? { ...value } : null;
      } catch {
        return null;
      }
    },

    audioFor(src) {
      const kind = videoSourceKind(src);
      if (!kind) return null;
      let url     ;
      try {
        url = new URL(src);
      } catch {
        return null;
      }
      if (url.username || url.password) return null;
      url.hash = "";
      const text = url.toString();
      if (isForbiddenHttpDestination(text)) return null;
      if (kind === "file") return text;
      const page = pages ? pages.peek(text) : null;
      if (!page || !page.ok || !page.audio) return null;

      if (pages && pages.proxied) return page.audio;

      void loadWholeAudio(page);
      return `${LIVEUI_AUDIO_PATH}?k=${audioToken(page)}`;
    },

    subtitlesFor(src) {
      if (videoSourceKind(src) !== "page" || !pages) return null;
      let url     ;
      try { url = new URL(src); } catch { return null; }
      if (url.username || url.password) return null;
      url.hash = "";
      const text = url.toString();
      if (isForbiddenHttpDestination(text)) return null;
      const page = pages.peek(text);
      if (!page || !page.ok || page.live || !page.info || !SUBTITLE_LANGUAGES.some((language) => selectVideoSubtitleTracks(page.info, language).length > 0)) return null;
      return `${LIVEUI_SUBTITLES_PATH}?k=${subtitleToken(text)}`;
    },

    async subtitles(token, language, from, kind) {
      const page = typeof token === "string" && /^[0-9a-f]{48}$/.test(token) ? subtitleTokens.get(token) : null;
      const resolved = page && pages ? pages.peek(page) : null;
      if (!resolved || !resolved.ok) return subtitleResponse(404, { code: "subtitles_unavailable" });

      if (resolved.live) return subtitleResponse(404, { code: "subtitles_unavailable" });
      const normalizedLanguage = normalizeLiveUiSubtitleLanguage(language);
      if (!normalizedLanguage) return subtitleResponse(400, { code: "subtitles_language_unsupported" });
      const normalizedKind = normalizeLiveUiSubtitleKind(kind);
      if (!normalizedKind) return subtitleResponse(400, { code: "subtitles_kind_unsupported" });
      const offset = from === undefined || from === null ? 0
        : typeof from === "number" ? from : typeof from === "string" && /^\d{1,4}$/.test(from) ? Number(from) : -1;
      if (!Number.isInteger(offset) || offset < 0 || offset >= 4000) return subtitleResponse(400, { code: "subtitles_bad_offset" });
      subtitleLoader ||= createVideoSubtitles({ trace: opts.trace, now });
      let track                      ;
      try { track = await subtitleLoader.load(resolved, normalizedLanguage, normalizedKind === "auto" ? undefined : normalizedKind); }
      catch { return subtitleResponse(502, { code: "subtitles_failed" }); }
      if (!track.ok) return subtitleResponse(track.code === "subtitles_unavailable" ? 404 : track.code === "subtitles_too_large" ? 413 : 502, { code: track.code });
      const cached = subtitleTrack(track);
      if (cached.tooLarge) return subtitleResponse(413, { code: "subtitles_too_large" });
      if (offset >= track.cues.length) return subtitleResponse(416, { code: "subtitles_bad_offset" });
      const result = (end        ) => ({
        language: track.language, kind: track.kind, cues: track.cues.slice(offset, end), trackId: cached.trackId,
        ...(end < track.cues.length ? { next: end } : {}),
      });

      const overhead = Buffer.byteLength(JSON.stringify({ language: track.language, kind: track.kind, cues: [], trackId: cached.trackId, next: 3999 }));
      let end = offset;
      while (end < track.cues.length) {
        const cueBytes = cached.prefixBytes[end + 1] - cached.prefixBytes[offset];
        const commas = end - offset;
        if (overhead + cueBytes + commas > LIVEUI_SUBTITLE_PAGE_BYTES) break;
        end++;
      }
      if (end === offset) return subtitleResponse(413, { code: "subtitles_too_large" });
      return subtitleResponse(200, result(end));
    },

    titleFor(src) {
      if (videoSourceKind(src) !== "page") return null;
      let url     ;
      try {
        url = new URL(src);
      } catch {
        return null;
      }
      url.hash = "";
      const text = url.toString();
      const page = resolver().peek(text);
      if (page) return page.ok && page.title ? page.title : null;

      if (opts.onTitle && !titleWaits.has(text)) {
        titleWaits.add(text);
        resolver()
          .resolve(text)
          .then((r) => {
            if (r.ok && r.title && opts.onTitle) opts.onTitle();
          })
          .catch(() => undefined)
          .finally(() => titleWaits.delete(text));
      }
      return null;
    },

    async audioRange(token, range) {
      const page = typeof token === "string" ? audioTokens.get(token) : undefined;
      const resolved = page && pages ? pages.peek(page) : null;
      if (!resolved || !resolved.ok || !resolved.audio) return plainResponse(404, "not found");
      const want = parseRange(range);
      if (!want) return plainResponse(416, "bad range");
      const whole = await loadWholeAudio(resolved);
      if (whole) {
        if (want.start >= whole.body.length) return plainResponse(416, "bad range");
        const last = Math.min(want.end === null ? whole.body.length - 1 : want.end, want.start + AUDIO_CHUNK_BYTES - 1, whole.body.length - 1);
        const part = whole.body.subarray(want.start, last + 1);
        return {
          statusCode: 206,
          headers: {
            "content-type": whole.type,
            "content-range": `bytes ${want.start}-${last}/${whole.body.length}`,
            "content-length": String(part.length),
            "accept-ranges": "bytes",
            "cache-control": "no-store",
          },
          body: Buffer.from(part),
        };
      }
      const end = want.end === null ? want.start + AUDIO_CHUNK_BYTES - 1 : Math.min(want.end, want.start + AUDIO_CHUNK_BYTES - 1);
      let upstream     ;
      try {
        upstream = await fetchAudio(resolved.audio, { ...(resolved.audioHeaders || {}), Range: `bytes=${want.start}-${end}` });
      } catch (err     ) {
        trace("liveui_v2_video_audio", { ok: false, error: String((err && err.message) || err).slice(0, 120) });
        return plainResponse(502, "sound unavailable");
      }
      if (upstream.status !== 200 && upstream.status !== 206) {
        try { await upstream.body?.cancel(); } catch {  }
        trace("liveui_v2_video_audio", { ok: false, status: upstream.status });
        return plainResponse(502, "sound unavailable");
      }
      let body        ;
      try {
        body = await readMediaBody(upstream, upstream.status === 200 ? MAX_WHOLE_AUDIO_BYTES : AUDIO_CHUNK_BYTES);
      } catch {
        return plainResponse(502, "sound unavailable");
      }

      let contentRange = upstream.headers.get("content-range");
      if (upstream.status === 200) {
        const total = body.length;
        body = body.subarray(want.start, end + 1);
        contentRange = `bytes ${want.start}-${want.start + body.length - 1}/${total}`;
      }
      return {
        statusCode: 206,
        headers: {
          "content-type": upstream.headers.get("content-type") || "audio/mp4",
          "content-range": contentRange || `bytes ${want.start}-${want.start + body.length - 1}/*`,
          "content-length": String(body.length),
          "accept-ranges": "bytes",
          "cache-control": "no-store",
        },
        body,
      };
    },

    prefetch(text) {
      if (typeof text !== "string" || !text) return 0;
      const links = [...new Set(text.match(/https?:\/\/[^\s<>"'`)\]]+/gi) || [])];
      let started = 0;
      for (const link of links) {
        if (started >= 3) break;
        if (videoSourceKind(link) !== "page") continue;

        const url = this.sourceUrl(link, "wearer", null);
        if (!url) continue;
        started++;
        resolver().resolve(url).catch(() => undefined);
      }
      if (started) trace("liveui_v2_video_resolve", { phase: "prefetch", pages: started });
      return started;
    },

    sourceUrl(src, reach, hostCheck) {
      if (!isVideoSource(src)) return null;
      let url     ;
      try {
        url = new URL(src);
      } catch {
        return null;
      }
      if (url.username || url.password) return null;
      url.hash = "";
      const text = url.toString();
      if (isForbiddenHttpDestination(text)) return null;
      if (reach !== "wearer") {
        let verdict = "";
        try {
          verdict = typeof hostCheck === "function" ? String(hostCheck(url.hostname)) : "";
        } catch {
          verdict = "";
        }
        if (verdict !== "listed") return null;
      }
      return text;
    },

    async poster(sessionKey, src, url) {
      const d = start(sessionKey, src, url);
      await settled(d.ready, RESOLVE_WAIT_MS);
      await waitFor(d, () => newest(d) >= 1 || (d.ended && d.frames.length > 0), POSTER_WAIT_MS);
      if (decoders.get(d.key) !== d) return null;
      if (!d.frames.length) {
        trace("liveui_v2_video_poster", { ok: false, error: d.error });
        return null;
      }
      const early = d.frames.filter((f) => f.at <= 1);
      const best = (early.length ? early : d.frames).reduce((a, b) => (b.sharp > a.sharp ? b : a));
      trace("liveui_v2_video_poster", { ok: true, at: best.at });
      return greyPng(boxedPoster(best.gray, lookOf(d)), VIDEO_W, VIDEO_H);
    },

    failReason(sessionKey, src) {
      const d = decoders.get(`${sessionKey}|${src}`);
      if (!d || !d.ended || d.frames.length) return null;
      return d.reason || (d.error ? "read_failed" : null);
    },

    heal(sessionKey, src, reason) {
      const program = reason === "ytdlp_missing" ? mediaBinary("ytdlp") : reason === "ffmpeg_missing" ? ffmpeg() : null;
      if (!program || !mediaBinaryFound(program)) return false;
      const d = decoders.get(`${sessionKey}|${src}`);
      if (d && d.ended && !d.frames.length) kill(d, "healed");
      return true;
    },

    async frame(sessionKey, src, url, t, options) {
      const want = Number.isFinite(t) && t > 0 ? t : 0;
      const explicit = options?.seek === true;
      const known = metadata.get(url)?.value;
      if (explicit && (!known?.seekable || !known.durationSec)) return { ok: false, end: true, code: "video_seek_unsupported" };
      if (known?.durationSec && want >= known.durationSec) return { ok: false, end: true };
      const canOffset = videoSourceKind(src) !== "page" || known?.seekable === true;

      const canSkip = canOffset || (!explicit && metadata.get(url)?.pipe === true && known?.live === false);
      let d = start(sessionKey, src, url, canSkip && (explicit || want > AHEAD_MAX_S) ? want : 0);

      if (d.ended && d.error && d.frames.length && want > newest(d)) {
        kill(d, "restart");
        d = start(sessionKey, src, url, canSkip ? want : 0);
      }
      const retained = d.frames.some((f) => f.at <= want && f.at >= want - PICK_WINDOW_S);

      if (!retained && ((explicit && Math.abs(want - d.offset) > PICK_WINDOW_S) ||
          (d.frames.length > 0 && want < d.frames[0].at - PICK_WINDOW_S) ||
          (canOffset && want > Math.max(d.offset, newest(d)) + AHEAD_MAX_S))) {
        kill(d, explicit ? "seek" : "reposition");
        d = start(sessionKey, src, url, canSkip ? want : 0);
      }
      if (explicit) {
        d.epoch++;
        d.wantAt = want;
      }
      const epoch = d.epoch;

      d.wantAt = Math.max(d.wantAt, want);
      steer(d);
      await settled(d.ready, RESOLVE_WAIT_MS);
      await waitFor(d, () => newest(d) >= want, WAIT_FRAME_MS);
      if (decoders.get(d.key) !== d || d.epoch !== epoch) return { ok: false, end: true, code: "video_superseded" };

      if (!d.frames.length && !d.error && !d.ended) {
        if (now() - d.startedAt < START_LIMIT_MS) return { ok: false, end: false, code: "video_starting" };
        trace("liveui_v2_video_decoder", { phase: "failed", error: "start_timeout", ms: now() - d.startedAt });
        kill(d, "start_timeout");
        return { ok: false, end: true, code: "video_failed" };
      }
      if (!d.frames.length) return { ok: false, end: true, ...(d.error ? { code: "video_failed" } : {}) };
      const last = d.frames[d.frames.length - 1];

      if (d.ended && want > last.at + 1) return { ok: false, end: true, ...(d.error ? { code: "video_failed" } : {}) };
      let pick               = null;

      const base = lookOf(d);
      const window = base.fine ? FINE_PICK_WINDOW_S : PICK_WINDOW_S;
      for (const f of d.frames) {
        if (f.at > want) break;
        if (f.at < want - window) continue;
        if (!pick || f.sharp > pick.sharp) pick = f;
      }
      if (!pick) pick = d.frames.filter((f) => f.at <= want).pop() || d.frames[0];
      if (explicit && Math.abs(pick.at - want) > PICK_WINDOW_S + 0.000001) return { ok: false, end: true, code: "video_seek_miss" };

      const busy = base.busy ?? (canGoBusy(base) && speedOn());
      const lk = busy === base.busy ? base : { ...base, busy };
      const levels = renderVideoFrame(pick.gray, pick.at, lk, d.state);
      const [w, h] = videoFrameSize(base);

      const look = busy && d.state.busy ? `${base.name}~rows` : base.name;
      return { ok: true, at: pick.at, data: packLevels(levels).toString("base64"), look, raw: base.raw === true, w, h };
    },

    dropSession(sessionKey) {
      for (const d of [...decoders.values()]) if (d.key.startsWith(`${sessionKey}|`)) kill(d, "session");
    },

    stats() {
      return { decoders: decoders.size };
    },
  };
}

function settled(p                  , ms        )                {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes        )         {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type        , data        )         {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function greyPng(gray            , w        , h        )         {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(gray.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

module.exports = { LIVEUI_AUDIO_PATH, LIVEUI_SUBTITLES_PATH, LIVEUI_SUBTITLE_PAGE_BYTES, LIVEUI_SUBTITLE_TRACK_BYTES, normalizeLiveUiSubtitleLanguage, normalizeLiveUiSubtitleKind, parseRange, videoDuration, isVideoSource, createLiveUiVideoService, greyPng };
