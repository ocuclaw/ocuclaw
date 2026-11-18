const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");
const { runHostCommand, startHostProcess } = require("../host-process.cjs");
const { runVideoCommand, startVideoDownload } = require("./media-process.cjs");
const { mediaBinary, mediaBinaryFound } = require("./media-binaries.cjs");

const VIDEO_FILE_RE = /\.(mp4|m4v|mov|webm|mkv|m3u8|ts)$/i;

const VIDEO_PAGES                          = [
  [/(^|\.)youtube(-nocookie)?\.com$/, /^\/(watch|shorts\/|live\/|embed\/|v\/)/],
  [/^youtu\.be$/, /^\/[\w-]{6,}/],
  [/(^|\.)vimeo\.com$/, /^\/(video\/)?\d+/],
  [/(^|\.)twitch\.tv$/, /^\/(videos\/\d+|[\w]+\/clip\/|[\w]+\/?$)/],
  [/^clips\.twitch\.tv$/, /^\/[\w-]+/],
  [/(^|\.)dailymotion\.com$/, /^\/(video|embed\/video)\//],
  [/^dai\.ly$/, /^\/\w+/],
  [/(^|\.)(x|twitter)\.com$/, /^\/\w+\/status\/\d+/],
  [/(^|\.)instagram\.com$/, /^\/(reels?|p|tv)\//],
  [/(^|\.)tiktok\.com$/, /^\/(@[\w.-]+\/video\/\d+|t\/\w+)/],
  [/(^|\.)reddit\.com$/, /^\/r\/\w+\/comments\//],
  [/^v\.redd\.it$/, /^\/\w+/],
  [/(^|\.)facebook\.com$/, /^\/(watch|reel\/|[\w.]+\/videos\/)/],
  [/^fb\.watch$/, /^\/\w+/],
  [/(^|\.)streamable\.com$/, /^\/\w+/],
  [/(^|\.)archive\.org$/, /^\/details\//],
  [/(^|\.)ted\.com$/, /^\/talks\//],
  [/(^|\.)bilibili\.com$/, /^\/video\//],
  [/(^|\.)rumble\.com$/, /^\/v\w+/],
  [/(^|\.)kick\.com$/, /^\/[\w-]+/],
  [/^bsky\.app$/, /^\/profile\/[^/]+\/post\//],

  [/./, /^\/(w\/[1-9A-HJ-NP-Za-km-z]{22}$|videos\/watch\/[0-9a-f-]{36}$)/],
];

const DIRECT_PROTOCOLS = new Set(["https", "http", "m3u8", "m3u8_native"]);

const OVERSAMPLE = 1.25;
const BOX                   = [288, 144];

const MIN_AUDIO_ABR = 48;
const RESOLVE_TIMEOUT_MS = 30000;
const RESOLVE_TTL_MS = 15 * 60 * 1000;
const FAILED_TTL_MS = 30 * 1000;
const MAX_KEEP_MS = 6 * 60 * 60 * 1000;
const EXPIRY_MARGIN_MS = 10 * 60 * 1000;
const YOUTUBE_HOSTS = /^(www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/i;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_REFUSED = 2;

const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 120 * 1000;

const STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;

const UPDATE_REFUSED_RE = /Use that to update|Use git to pull|Build the executable again/i;

function ytDlpUpdateOutcome(code               , text        )                     {
  if (code === 0) return /Updated yt-dlp to/i.test(text) ? "updated" : "current";
  return UPDATE_REFUSED_RE.test(text) ? "refused" : "failed";
}

function ytDlpReleaseTime(version        )                {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

function videoSourceKind(src        )                         {
  let url     ;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (VIDEO_FILE_RE.test(url.pathname)) return "file";
  const host = url.hostname.toLowerCase();
  if (VIDEO_PAGES.some(([h, p]) => h.test(host) && p.test(url.pathname))) return "page";
  return url.hash.toLowerCase().includes("video") ? "page" : null;
}

function num(v         )                {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function hasVideo(f        )          {
  if (f.vcodec === "none") return false;
  if (f.protocol === "mhtml" || /storyboard/i.test(String(f.format_note || ""))) return false;
  if (f.vcodec || num(f.height) !== null || num(f.width) !== null) return true;

  if (f.video_ext === "none" || /audio[ -]?only/i.test(String(f.resolution || ""))) return false;
  return /^(mp4|m4v|mov|webm|mkv)$/i.test(String(f.video_ext || f.ext || ""));
}

function hasAudio(f        )          {
  return f.acodec !== "none" && (typeof f.acodec === "string" || f.vcodec === "none");
}

function maybeAudio(f        )          {
  return f.acodec !== "none";
}

function area(f        )         {
  const w = num(f.width);
  const h = num(f.height);
  if (w !== null && h !== null) return w * h;
  if (h !== null) return Math.round((h * 16) / 9) * h;
  if (w !== null) return w * Math.round((w * 9) / 16);
  return 0;
}

function codecCost(vcodec         )         {
  const c = String(vcodec || "");
  if (/^(avc|h264)/i.test(c)) return 0;
  if (/^(vp0?9|vp8)/i.test(c)) return 1;
  if (/^(hev|hvc|h265)/i.test(c)) return 2;
  if (/^av0?1/i.test(c)) return 3;
  return 1;
}

function rate(f        )         {
  return num(f.tbr) ?? num(f.vbr) ?? num(f.abr) ?? num(f.filesize) ?? num(f.filesize_approx) ?? 0;
}

function pickVideoFormat(formats          , box                   = BOX, avoid                      = new Set())                {
  const usable = (formats || []).filter((f) => f && typeof f.url === "string" && hasVideo(f) && !f.has_drm);
  if (!usable.length) return null;
  const covers = (f        ) => {
    let w = num(f.width);
    let h = num(f.height);
    if (w === null && h === null) return true;
    if (w === null) w = ((h          ) * 16) / 9;
    if (h === null) h = (w * 9) / 16;
    return Math.max(box[0] / w, box[1] / h) <= 1 / OVERSAMPLE;
  };

  const order = (a        , b        ) =>
    Number(avoid.has(a.protocol)) - Number(avoid.has(b.protocol)) ||
    area(a) - area(b) ||
    Number(hasAudio(a)) - Number(hasAudio(b)) ||
    codecCost(a.vcodec) - codecCost(b.vcodec) ||
    Number(!DIRECT_PROTOCOLS.has(a.protocol)) - Number(!DIRECT_PROTOCOLS.has(b.protocol)) ||
    rate(a) - rate(b);
  const big = usable.filter(covers).sort(order);
  if (big.length) return big[0];
  return usable.sort((a, b) => Number(avoid.has(a.protocol)) - Number(avoid.has(b.protocol)) || area(b) - area(a) || order(a, b))[0];
}

function pickAudioFormat(formats          )                {
  const https = (f        ) => typeof f.url === "string" && f.url.startsWith("https://") && !f.has_drm;
  const only = (formats || []).filter((f) => f && https(f) && f.vcodec === "none" && f.acodec !== "none" && f.protocol === "https");
  if (only.length) {
    const aac = (f        ) => (/^mp4a|^aac/i.test(String(f.acodec || "")) || f.ext === "m4a" ? 0 : 1);
    const kbps = (f        ) => num(f.abr) ?? num(f.tbr) ?? 128;
    const enough = only.filter((f) => kbps(f) >= MIN_AUDIO_ABR);
    return (enough.length ? enough : only).sort((a, b) => aac(a) - aac(b) || kbps(a) - kbps(b))[0];
  }
  const muxed = (formats || []).filter((f) => f && https(f) && hasVideo(f) && maybeAudio(f));

  const order = (a        , b        ) =>
    Number(!hasAudio(a)) - Number(!hasAudio(b)) ||
    Number(a.ext !== "mp4") - Number(b.ext !== "mp4") ||
    (area(a) || rate(a)) - (area(b) || rate(b));
  const file = muxed.filter((f) => f.protocol === "https").sort(order);
  if (file.length) return file[0];
  const hls = muxed.filter((f) => f.protocol === "m3u8" || f.protocol === "m3u8_native").sort(order);
  return hls[0] || null;
}

function firstVideo(info                     )                             {
  if (info && Array.isArray(info.formats) && info.formats.length) return info;
  if (info && Array.isArray(info.entries)) {
    for (const e of info.entries) {
      const v = e && firstVideo(e);
      if (v) return v;
    }
  }
  if (info && typeof info.url === "string" && !info.formats) return { ...info, formats: [{ ...info }] };
  return null;
}

function headersOf(f        , info                     )                         {
  const out                         = {};
  const from = { ...(info.http_headers || {}), ...(f.http_headers || {}) };
  for (const [k, v] of Object.entries(from)) {

    if (typeof v === "string" && !/[\r\n]/.test(v) && /^[\w-]+$/.test(k)) out[k] = v;
  }
  if (typeof f.cookies === "string" && f.cookies && !/[\r\n]/.test(f.cookies)) out.Cookie = f.cookies;
  return out;
}

function readResolved(page        , info                     )                {
  const entry = firstVideo(info);
  if (!entry) return { ok: false, code: "video_no_stream", error: "no streams" };
  const formats           = entry.formats;
  const pick = pickVideoFormat(formats);
  if (!pick || isForbiddenHttpDestination(pick.url)) return { ok: false, code: "video_no_stream", error: "no video stream" };
  const live = entry.is_live === true;

  const sound = live ? null : pickAudioFormat(formats);
  const audio = sound && !isForbiddenHttpDestination(sound.url) ? String(sound.url) : null;
  return {
    ok: true,
    page,
    extractor: String(entry.extractor_key || entry.extractor || info.extractor_key || "generic"),
    title: typeof entry.title === "string" ? entry.title.slice(0, 200) : null,
    duration: num(entry.duration),
    live,
    video: streamOf(pick, entry),
    pipe: !DIRECT_PROTOCOLS.has(String(pick.protocol || "https")),
    audio,
    audioHeaders: audio && sound ? headersOf(sound, entry) : {},
    info: entry,
  };
}

function streamOf(pick        , entry                     )              {
  return {
    url: String(pick.url),
    headers: headersOf(pick, entry),
    protocol: String(pick.protocol || "https"),
    formatId: String(pick.format_id || ""),
    width: num(pick.width),
    height: num(pick.height),
    vcodec: typeof pick.vcodec === "string" ? pick.vcodec : null,
  };
}

function nextStream(resolved                                      , alwaysPipe = false)                                              {
  const refused = [...(resolved.refused || []), { formatId: resolved.video.formatId, protocol: resolved.video.protocol }];
  if (refused.length > MAX_REFUSED) return null;
  const ids = new Set(refused.map((r) => r.formatId));
  const entry = resolved.info                       ;
  const formats = (Array.isArray(entry.formats) ? entry.formats : []).filter((f        ) => f && !ids.has(String(f.format_id)));
  const pick = pickVideoFormat(formats, BOX, new Set(refused.map((r) => r.protocol)));
  if (!pick || isForbiddenHttpDestination(pick.url)) return null;
  return {
    ...resolved,
    video: streamOf(pick, entry),
    pipe: !(resolved.live && /^m3u8/.test(String(pick.protocol))) && (alwaysPipe || !DIRECT_PROTOCOLS.has(String(pick.protocol || "https"))),
    refused,
  };
}

function pageKey(page        )         {
  let url     ;
  try {
    url = new URL(page);
  } catch {
    return page;
  }
  if (!YOUTUBE_HOSTS.test(url.hostname)) return page;
  const id = url.hostname.toLowerCase() === "youtu.be"
    ? url.pathname.slice(1).split("/")[0]
    : url.searchParams.get("v") || (url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/) || [])[1] || "";
  return /^[\w-]{6,20}$/.test(id) ? `youtube:${id}` : page;
}

function keepFor(resolved               , nowMs        )         {
  if (!resolved.ok) return FAILED_TTL_MS;
  if (resolved.live) return RESOLVE_TTL_MS;
  let expire = NaN;
  try {
    expire = Number(new URL(resolved.video.url).searchParams.get("expire")) * 1000;
  } catch {
    expire = NaN;
  }
  if (!Number.isFinite(expire) || expire <= 0) return RESOLVE_TTL_MS;
  return Math.max(0, Math.min(MAX_KEEP_MS, expire - EXPIRY_MARGIN_MS - nowMs));
}

function videoProxy(value         )                {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return /^(socks5h?|socks4a?|https?):\/\/\S+$/i.test(v) ? v : null;
}

let runtimeProxy                           ;

function setVideoProxy(value                           )       {
  runtimeProxy = value === undefined ? undefined : videoProxy(value);
}

function currentVideoProxy()                {
  return runtimeProxy !== undefined ? runtimeProxy : videoProxy(process.env.OCUCLAW_VIDEO_PROXY);
}

function createVideoResolver(opts                       = {})                {

  const ytdlp = ()         => mediaBinary("ytdlp", opts.ytdlp);
  const node = opts.node || process.execPath;
  const fixedProxy = opts.proxy !== undefined ? videoProxy(opts.proxy) : undefined;

  const proxyNow = ()                => (fixedProxy !== undefined ? fixedProxy : currentVideoProxy());
  const runCommand = opts.run || runHostCommand;
  const spawn = opts.spawn || startHostProcess;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const kept = new Map                                                                                                               ();
  let runtimeFlag = true;
  let updateTriedAt = -Infinity;
  let updating                                                 = null;

  function trace(event        , data                         )       {
    try {
      if (typeof opts.trace === "function") opts.trace(event, data);
    } catch {

    }
  }

  function baseArgs(withRuntime         )           {
    return [
      "--ignore-config", "--no-playlist", "--no-warnings", "--no-progress", "--force-ipv4",
      "--socket-timeout", "15",
      "--downloader", "dash:native",

      ...(withRuntime ? ["--js-runtimes", `node:${node}`] : []),
    ];
  }

  async function run(page        , withRuntime         )                                                                                            {
    const r = await runVideoCommand([ytdlp(), ...baseArgs(withRuntime), "-J", "--", page], {
      proxy: proxyNow(), run: runCommand,
      timeoutMs: RESOLVE_TIMEOUT_MS,
      maxOutputBytes: MAX_JSON_BYTES,
    });
    const err = `${r.timedOut ? "timed out\n" : ""}${r.stderr}`.slice(0, 4000);
    return { code: r.code, out: r.truncated ? "" : r.stdout, err, missing: r.missing, via: r.via };
  }

  function selfUpdate()                                          {
    if (updating) return updating;
    if (now() - updateTriedAt < UPDATE_EVERY_MS) return Promise.resolve("skipped");
    updateTriedAt = now();
    const started = now();
    updating = runCommand([ytdlp(), "-U"], { timeoutMs: UPDATE_TIMEOUT_MS })
      .then((r) => {
        const outcome = r.missing ? "failed" : ytDlpUpdateOutcome(r.code, `${r.stdout}\n${r.stderr}`);
        trace("liveui_v2_video_ytdlp_update", { outcome, ms: now() - started });
        return outcome;
      })
      .finally(() => {
        updating = null;
      });
    return updating;
  }

  async function stale()                   {
    const r = await runVideoCommand([ytdlp(), "--version"], { timeoutMs: 15000, proxy: proxyNow(), run: runCommand });
    const released = r.code === 0 ? ytDlpReleaseTime(r.stdout) : null;
    return released !== null && now() - released > STALE_AFTER_MS;
  }

  async function read(page        )                         {
    const started = now();
    const proxy = proxyNow();
    let r = await run(page, runtimeFlag);

    if (r.code !== 0 && /no such option.*js-runtimes/i.test(r.err)) {
      runtimeFlag = false;
      r = await run(page, false);
    }
    if (r.missing) {
      trace("liveui_v2_video_resolve", { ok: false, code: "video_needs_ytdlp", ms: now() - started });
      return { ok: false, code: "video_needs_ytdlp", error: "yt-dlp is not installed on the host" };
    }
    let ytdlpStale = false;
    if (r.code !== 0) {
      const outcome = await selfUpdate();
      if (outcome === "updated") {
        runtimeFlag = true;
        r = await run(page, runtimeFlag);
      } else if (outcome === "refused") {
        ytdlpStale = await stale();
      }
    }
    let info      = null;
    if (r.code === 0) {
      try {
        info = JSON.parse(r.out);
      } catch {
        info = null;
      }
    }
    if (!info) {
      const error = (r.err.trim().split("\n").filter((l) => /ERROR/.test(l)).pop() || r.err.trim().split("\n").pop() || `exit ${r.code}`).slice(0, 300);
      trace("liveui_v2_video_resolve", { ok: false, code: "video_resolve_failed", error, ...(ytdlpStale ? { stale: true } : {}), ms: now() - started });
      return { ok: false, code: "video_resolve_failed", error, ...(ytdlpStale ? { ytdlpStale: true          } : {}) };
    }
    const picked = readResolved(page, info);

    const resolved                = proxy && picked.ok && !(picked.live && /^m3u8/.test(picked.video.protocol)) ? { ...picked, pipe: true } : picked;
    trace(
      "liveui_v2_video_resolve",
      resolved.ok
        ? {
            ok: true,
            extractor: resolved.extractor,
            live: resolved.live,
            format: resolved.video.formatId,
            size: resolved.video.width && resolved.video.height ? `${resolved.video.width}x${resolved.video.height}` : null,
            vcodec: resolved.video.vcodec,
            protocol: resolved.video.protocol,
            pipe: resolved.pipe,
            proxy: proxy !== null,
            via: r.via,
            audio: resolved.audio !== null,
            ms: now() - started,
          }
        : { ok: false, code: resolved.code, ms: now() - started },
    );
    return resolved;
  }

  return {
    get proxied() {
      return proxyNow() !== null;
    },

    resolve(page) {
      const key = pageKey(page);
      const have = kept.get(key);
      const t = now();

      const failed = have && have.value && !have.value.ok ? have.value : null;
      const healed = failed !== null && failed.code === "video_needs_ytdlp" && mediaBinaryFound(ytdlp());
      if (have && have.proxy === proxyNow() && (!have.value || (t < have.until && !healed))) return have.promise;
      const entry = { until: Infinity, promise: null                                     , value: null                        , proxy: proxyNow() };
      entry.promise = read(page).then((v) => {
        entry.value = v;
        entry.until = now() + keepFor(v, now());
        return v;
      });
      kept.set(key, entry);
      for (const [k, v] of kept) if (v.value && now() >= v.until) kept.delete(k);
      return entry.promise;
    },

    peek(page) {
      const have = kept.get(pageKey(page));
      return have && have.value ? have.value : null;
    },

    async pipe(resolved, signal) {

      if (resolved.live && /^m3u8/.test(resolved.video.protocol)) throw new Error("Live HLS must use the video relay");
      const dir = mkdtempSync(join(tmpdir(), "ocuclaw-video-"));
      const file = join(dir, "info.json");
      try {
        writeFileSync(file, JSON.stringify(resolved.info), { mode: 0o600 });
        const child = await startVideoDownload(
          ytdlp(),
          [...baseArgs(runtimeFlag), "--load-info-json", file, "-f", resolved.video.formatId, "--no-part", "--quiet", "-o", "-"],

          { stdio: ["ignore", "pipe", "pipe"], cwd: dir, proxy: proxyNow(), signal, spawn },
        );
        child.on("close", () => rmSync(dir, { recursive: true, force: true }));
        child.on("error", () => rmSync(dir, { recursive: true, force: true }));
        return child;
      } catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
    },

    fallback(resolved) {
      const next = nextStream(resolved, proxyNow() !== null);
      trace("liveui_v2_video_resolve", {
        ok: next !== null,
        phase: "fallback",
        refused: resolved.video.formatId,
        ...(next ? { format: next.video.formatId, protocol: next.video.protocol, pipe: next.pipe } : { code: "video_no_stream" }),
      });

      const have = kept.get(pageKey(resolved.page));
      if (next && have && have.value && have.value.ok) {
        have.value = next;
        have.promise = Promise.resolve(next);
      }
      return next;
    },
  };
}

module.exports = { ytDlpUpdateOutcome, ytDlpReleaseTime, videoSourceKind, pickVideoFormat, pickAudioFormat, readResolved, nextStream, pageKey, keepFor, videoProxy, setVideoProxy, currentVideoProxy, createVideoResolver };
