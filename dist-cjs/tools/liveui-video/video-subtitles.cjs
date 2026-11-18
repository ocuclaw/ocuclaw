const { Buffer } = require("node:buffer");
const { createHash } = require("node:crypto");
const { isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");
const { currentVideoProxy } = require("./video-source.cjs");
const { createVideoSubtitleFetch } = require("./video-subtitle-fetch.cjs");

const VIDEO_SUBTITLE_LIMITS = Object.freeze({
  bytes: 1024 * 1024, cues: 4000, rawCues: 12000, cueChars: 500,
  timeSec: 86400, timeoutMs: 6000, attempts: 4, cacheEntries: 8,
  cacheMs: 10 * 60 * 1000, failureCacheMs: 30000, redirects: 3,
});

function languageKey(value         )                {
  return typeof value === "string" && value.length <= 64 && /^[a-z]{2,8}(?:[-_][a-z0-9]{1,16}){0,6}$/i.test(value)
    ? value.toLowerCase().replace(/_/g, "-") : null;
}
function safeUrl(value         )                {
  if (typeof value !== "string" || value.length > 8192 || isForbiddenHttpDestination(value)) return null;
  try { const url = new URL(value); return !url.username && !url.password ? url.toString() : null; } catch { return null; }
}
function safeHeaders(...values           )                         {
  const out                         = {};
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      if (/^[\w-]{1,64}$/.test(key) && typeof item === "string" && item.length <= 4096 && !/[\r\n]/.test(item) &&
          !/^(host|connection|content-length|transfer-encoding|proxy-authorization|proxy-connection)$/i.test(key)) out[key.toLowerCase()] = item;
    }
  }
  let bytes = 0;
  return Object.fromEntries(Object.entries(out).filter(([key, value], index) => {
    bytes += Buffer.byteLength(key + value);
    return index < 32 && bytes <= 16384;
  }));
}

const LANGUAGE_FAMILIES                                                                             = {
  "zh-cn": { exact: ["zh-cn", "zh-hans", "zh-sg", "zh"], prefix: ["zh-cn", "zh-hans"], translateTo: "zh-Hans" },
  "zh-tw": { exact: ["zh-tw", "zh-hant", "zh-hk", "zh-mo", "zh"], prefix: ["zh-tw", "zh-hant"], translateTo: "zh-Hant" },
};
function languageFamily(requested        )                                                             {
  const base = requested.split("-")[0];
  return LANGUAGE_FAMILIES[requested] || (requested === base
    ? { exact: [requested], prefix: [requested], translateTo: requested }
    : { exact: [requested, base], prefix: [requested], translateTo: base });
}

function languageRank(language        , family                                       )                {
  const exact = family.exact.indexOf(language);
  if (exact >= 0) return exact;
  const prefix = family.prefix.findIndex((tag) => language.startsWith(`${tag}-`));
  return prefix >= 0 ? family.exact.length + prefix : null;
}
function isTranslation(url        )          { return new URL(url).searchParams.has("tlang"); }

function youtubeTimedText(url        )          {
  const parsed = new URL(url);
  return /^(?:www\.|m\.)?youtube\.com$/.test(parsed.hostname) && parsed.pathname === "/api/timedtext";
}

function selectVideoSubtitleTracks(info                         , requestedLanguage        )                       {
  const requested = languageKey(requestedLanguage);
  if (!requested) return [];
  const family = languageFamily(requested);

  const groups                                                                                                                                       =
    { creator: [], automatic: [], creatorTranslated: [], automaticTranslated: [], creatorOriginal: [], automaticOriginal: [] };
  let translatable                   = null;

  const spoken = languageKey(info?.language)?.split("-")[0] ?? null;
  for (const [field, kind] of [["subtitles", "creator"], ["automatic_captions", "automatic"]]         ) {
    const catalog = info?.[field];
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) continue;
    const preferred                        = kind === "creator" ? ["vtt", "srt", "json3"] : ["json3", "vtt", "srt"];
    let languages = 0;
    for (const [key, tracks] of Object.entries(catalog).slice(0, 512)) {
      const language = languageKey(key);
      if (!language || !Array.isArray(tracks)) continue;
      const rank = languageRank(language, family);
      const original = rank === null ? groups[kind === "creator" ? "creatorOriginal" : "automaticOriginal"] : null;
      if (original && original.length >= 32) continue;
      if (rank !== null && ++languages > 16) continue;
      for (const raw of tracks.slice(0, 32)) {
        if (!raw || typeof raw !== "object") continue;
        const format = String(raw.ext || "").toLowerCase()                       ;
        const url = safeUrl(raw.url);
        if (!preferred.includes(format) || !url) continue;
        const track            = { language, kind, format, url, headers: safeHeaders(info.http_headers, raw.http_headers), rolling: kind === "automatic", translated: kind === "automatic" && isTranslation(url), rank: rank ?? 0 };
        if (original) {
          if (isTranslation(url)) continue;
          if (kind === "creator" && !translatable && format === "json3" && youtubeTimedText(url)) translatable = track;
          if (original.length < 32) original.push({ ...track, rank: language.split("-")[0] === spoken ? 0 : 1 });
          continue;
        }
        groups[kind === "creator" ? "creator" : track.translated ? "automaticTranslated" : "automatic"].push(track);
      }
    }
  }
  if (!groups.creator.length && translatable) {
    const url = new URL(translatable.url);
    url.searchParams.set("tlang", family.translateTo);

    groups.creatorTranslated.push({ ...translatable, url: url.toString(), language: requested, kind: "automatic", rolling: false, translated: true, rank: 0 });
  }
  if (groups.creator.length || groups.automatic.length) groups.creatorOriginal = groups.automaticOriginal = [];
  const out                       = [];
  for (const [group, limit] of [["creator", 2], ["automatic", 2], ["creatorTranslated", 1], ["automaticTranslated", 2], ["creatorOriginal", 1], ["automaticOriginal", 1]]         ) {
    const preferred                        = group === "creator" || group === "creatorOriginal" ? ["vtt", "srt", "json3"] : ["json3", "vtt", "srt"];
    const candidates = groups[group].sort((a, b) => a.rank - b.rank || preferred.indexOf(a.format) - preferred.indexOf(b.format));

    const seen = new Set        (), languages = new Set        (), picked              = [];
    for (const pass of [0, 1]) for (const track of candidates) {
      if (picked.length === limit) break;
      const key = `${track.format}:${track.url}`;
      if (seen.has(key) || (pass === 0 && languages.has(track.language))) continue;
      seen.add(key); languages.add(track.language); picked.push(track);
    }
    for (const { rank: _rank, ...track } of picked.sort((a, b) => a.rank - b.rank)) out.push(track);
  }
  return out;
}

function plainText(text        )         {
  const entities                         = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/<[^<>]*>/g, "").replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity        ) => {
    if (entity[0] !== "#") return entities[entity.toLowerCase()] || all;
    const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
  }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .split(/\r?\n/).map((line) => line.replace(/[\t\f\v ]+/g, " ").trim()).filter(Boolean).join("\n");
}
function seconds(value        )                {
  const match = /^(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!match) return null;
  const n = Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  return n <= VIDEO_SUBTITLE_LIMITS.timeSec ? n : null;
}

function normalize(raw          , rolling         )                       {
  if (raw.length > VIDEO_SUBTITLE_LIMITS.rawCues) return { ok: false, code: "subtitles_too_large" };
  const result           = [];
  raw.sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  for (const cue of raw) {
    if (!Number.isFinite(cue.startSec) || !Number.isFinite(cue.endSec) || cue.startSec < 0 || cue.endSec <= cue.startSec || cue.endSec > VIDEO_SUBTITLE_LIMITS.timeSec) continue;
    const separator = /^\s*\n/.test(cue.text) ? "\n" : /^\s/.test(cue.text) ? " " : "";
    cue.text = plainText(cue.text);
    if (!cue.text) continue;
    if (cue.text.length > VIDEO_SUBTITLE_LIMITS.cueChars * 2 || [...cue.text].length > VIDEO_SUBTITLE_LIMITS.cueChars) return { ok: false, code: "subtitles_too_large" };
    const previous = result.at(-1);
    const separateWindows = previous && previous.window !== undefined && cue.window !== undefined && previous.window !== cue.window;
    if (rolling && previous && !separateWindows && cue.startSec < previous.endSec) {
      const sameWindow = cue.window !== undefined && cue.window === previous.window;
      if (cue.append && sameWindow && cue.endSec - previous.startSec <= 15 && [...previous.text, ...cue.text].length <= VIDEO_SUBTITLE_LIMITS.cueChars) {
        previous.text = plainText(previous.text + separator + cue.text);
        previous.endSec = Math.max(previous.endSec, cue.endSec);
        continue;
      }

      if (cue.text === previous.text || (cue.text.startsWith(previous.text) && cue.text.length > previous.text.length && !cue.text.slice(previous.text.length).includes("\n"))) {
        previous.text = cue.text;
        previous.endSec = Math.max(previous.endSec, cue.endSec);
        continue;
      }

      const lines = cue.text.split("\n"), oldLines = previous.text.split("\n");
      let common = 0;
      for (let n = Math.min(lines.length - 1, oldLines.length); n > 0; n--) {
        if (oldLines.slice(-n).join("\n") === lines.slice(0, n).join("\n")) { common = n; break; }
      }
      if (common) cue.text = lines.slice(common).join("\n");

      if (cue.startSec > previous.startSec) previous.endSec = Math.min(previous.endSec, cue.startSec);
    }
    result.push(cue);
    if (result.length > VIDEO_SUBTITLE_LIMITS.cues) return { ok: false, code: "subtitles_too_large" };
  }
  const cues = result.map(({ startSec, endSec, text }) => ({ startSec, endSec, text }));
  if (Buffer.byteLength(JSON.stringify(cues), "utf8") > VIDEO_SUBTITLE_LIMITS.bytes) return { ok: false, code: "subtitles_too_large" };
  return cues.length ? { ok: true, cues } : { ok: false, code: "subtitles_invalid" };
}

function parseVideoSubtitles(text        , format                     , options                        = {})                       {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > VIDEO_SUBTITLE_LIMITS.bytes) return { ok: false, code: "subtitles_too_large" };
  const raw           = [];
  if (format === "json3") {
    let document     ;
    try { document = JSON.parse(text); } catch { return { ok: false, code: "subtitles_invalid" }; }
    if (!Array.isArray(document?.events)) return { ok: false, code: "subtitles_invalid" };
    if (document.events.length > VIDEO_SUBTITLE_LIMITS.rawCues) return { ok: false, code: "subtitles_too_large" };
    for (const event of document.events) {
      if (!event || !Array.isArray(event.segs)) continue;
      if (event.segs.length > VIDEO_SUBTITLE_LIMITS.cueChars) return { ok: false, code: "subtitles_too_large" };
      const startSec = typeof event.tStartMs === "number" ? event.tStartMs / 1000 : NaN;
      const endSec = typeof event.dDurationMs === "number" ? startSec + event.dDurationMs / 1000 : NaN;
      raw.push({ startSec, endSec, text: event.segs.map((segment     ) => typeof segment?.utf8 === "string" ? segment.utf8 : "").join(""), append: event.aAppend === 1, window: typeof event.wWinId === "number" ? event.wWinId : 0 });
    }
  } else if (format === "vtt" || format === "srt") {
    for (const block of text.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/)) {
      if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(block.trimStart())) continue;
      const lines = block.split("\n"), index = lines.findIndex((line) => line.includes("-->"));
      if (index < 0) continue;
      const m = /^\s*(\S+)\s+-->\s+(\S+)/.exec(lines[index]);
      if (!m) continue;
      const startSec = seconds(m[1]), endSec = seconds(m[2]);
      if (startSec === null || endSec === null) continue;
      raw.push({ startSec, endSec, text: lines.slice(index + 1).join("\n") });
      if (raw.length > VIDEO_SUBTITLE_LIMITS.rawCues) return { ok: false, code: "subtitles_too_large" };
    }
  } else return { ok: false, code: "subtitles_invalid" };
  return normalize(raw, options.rolling ?? format === "json3");
}

function raceAbort   (promise            , signal             )             {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise   ((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
function cancel(response     )       { try { Promise.resolve(response?.body?.cancel()).catch(() => undefined); } catch {  } }

function createVideoSubtitles(opts                        = {})                 {
  const now = opts.now || Date.now;
  const route = opts.proxy || currentVideoProxy;
  const cache = new Map                                                                                                ();
  const fetchTrack = opts.fetch || createVideoSubtitleFetch();
  const timeoutMs = Math.min(VIDEO_SUBTITLE_LIMITS.timeoutMs, Math.max(1, opts.timeoutMs || VIDEO_SUBTITLE_LIMITS.timeoutMs));
  const trace = (data                         ) => { try { opts.trace?.("liveui_v2_video_subtitles", data); } catch {  } };

  async function download(track                    , proxy               , signal             , note                                )                                {
    let url = track.url;
    let crossedOrigin = false;
    const original = new URL(url).origin;
    for (let hop = 0; hop <= VIDEO_SUBTITLE_LIMITS.redirects; hop++) {
      if (!safeUrl(url)) return { ok: false, code: "subtitles_failed" };
      crossedOrigin ||= new URL(url).origin !== original;
      const headers = !crossedOrigin ? track.headers : safeHeaders({ Accept: "text/vtt,application/json,text/plain" });
      let response     ;
      try {
        response = await raceAbort(Promise.resolve(fetchTrack(url, { headers, signal, redirect: "manual", proxy })), signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers?.get("location");
          cancel(response);
          if (!location || hop === VIDEO_SUBTITLE_LIMITS.redirects) return { ok: false, code: "subtitles_failed" };
          url = new URL(location, url).toString();
          continue;
        }
        if (response.status !== 200) { note(Number(response.status) || "network"); cancel(response); return { ok: false, code: "subtitles_failed" }; }
        const declared = Number(response.headers?.get("content-length"));
        if (Number.isFinite(declared) && declared > VIDEO_SUBTITLE_LIMITS.bytes) { cancel(response); return { ok: false, code: "subtitles_too_large" }; }
        if (!response.body || typeof response.body.getReader !== "function") { cancel(response); return { ok: false, code: "subtitles_failed" }; }
        const reader = response.body.getReader(), chunks           = [];
        let size = 0;
        try {
          for (;;) {
            const part = await raceAbort(Promise.resolve(reader.read()), signal);
            if (part.done) break;
            if (!(part.value instanceof Uint8Array) || part.value.byteLength > VIDEO_SUBTITLE_LIMITS.bytes - size) return { ok: false, code: "subtitles_too_large" };
            const chunk = Buffer.from(part.value);
            size += chunk.length;
            chunks.push(chunk);
          }
        } finally { try { Promise.resolve(reader.cancel()).catch(() => undefined); } catch {  } }
        return parseVideoSubtitles(Buffer.concat(chunks, size).toString("utf8"), track.format, { rolling: track.rolling });
      } catch { note(signal.aborted ? "timeout" : "network"); cancel(response); return { ok: false, code: "subtitles_failed" }; }
    }
    return { ok: false, code: "subtitles_failed" };
  }

  return {
    load(resolved, language, kind) {
      const tracks = selectVideoSubtitleTracks(resolved.info, language).filter((track) => !kind || track.kind === kind);
      if (!tracks.length) return Promise.resolve({ ok: false, code: "subtitles_unavailable" });
      const proxy = route();
      const key = createHash("sha256").update(JSON.stringify([resolved.page, resolved.duration, languageKey(language), proxy, tracks])).digest("hex");
      const have = cache.get(key);
      if (have && now() < have.until) return have.promise;
      if (have) { have.controller.abort(); cache.delete(key); }
      while (cache.size >= VIDEO_SUBTITLE_LIMITS.cacheEntries) {
        const first = cache.keys().next().value          ;
        cache.get(first)?.controller.abort(); cache.delete(first);
      }
      const controller = new AbortController();
      const entry = { until: Infinity, promise: null                                            , controller };
      const deadline = setTimeout(() => controller.abort(), timeoutMs);
      const attempts                            = [];
      entry.promise = (async ()                                => {
        let failed                       = { ok: false, code: "subtitles_failed" };
        const startedAt = Date.now();

        let made = 0, translationLimited = false;
        const planned = (index        ) => tracks.slice(index).filter((track) => !(translationLimited && track.translated)).length;
        for (const [index, track] of tracks.entries()) {
          if (controller.signal.aborted || made === VIDEO_SUBTITLE_LIMITS.attempts) break;
          if (translationLimited && track.translated) continue;
          made++;
          const attempt = new AbortController();
          const stop = () => attempt.abort();
          controller.signal.addEventListener("abort", stop, { once: true });

          const share = Math.floor((timeoutMs - (Date.now() - startedAt)) / Math.min(planned(index), VIDEO_SUBTITLE_LIMITS.attempts - made + 1));
          const attemptDeadline = setTimeout(stop, Math.max(1, share));
          let parsed                      ;
          const tried                          = { kind: track.kind, language: track.language, format: track.format, translated: track.translated };
          attempts.push(tried);
          try { parsed = await download(track, proxy, attempt.signal, (why) => { tried.failed = why; if (why === 429 && track.translated) translationLimited = true; }); }
          finally { clearTimeout(attemptDeadline); controller.signal.removeEventListener("abort", stop); }
          if (!parsed.ok) { tried.failed ??= parsed.code; failed = parsed; continue; }
          const duration = resolved.duration;
          const cues = parsed.cues.filter((cue) => duration === null || cue.startSec < duration).map((cue) => ({ ...cue, endSec: duration === null ? cue.endSec : Math.min(cue.endSec, duration) }));
          if (cues.length) {
            const result                       = { ok: true, language: track.language, kind: track.kind, cues };
            if (Buffer.byteLength(JSON.stringify(result), "utf8") <= VIDEO_SUBTITLE_LIMITS.bytes) return result;
            failed = { ok: false, code: "subtitles_too_large" };
            tried.failed = failed.code;
          } else tried.failed = "empty";
        }
        return failed;
      })().then((result) => {
        entry.until = now() + (result.ok ? VIDEO_SUBTITLE_LIMITS.cacheMs : VIDEO_SUBTITLE_LIMITS.failureCacheMs);

        trace(result.ok ? { ok: true, language: result.language, kind: result.kind, cues: result.cues.length, attempts } : { ok: false, code: result.code, attempts });
        return result;
      }).finally(() => clearTimeout(deadline));
      cache.set(key, entry);
      return entry.promise;
    },
    clear() {
      for (const entry of cache.values()) entry.controller.abort();
      cache.clear();
    },
  };
}

module.exports = { VIDEO_SUBTITLE_LIMITS, selectVideoSubtitleTracks, parseVideoSubtitles, createVideoSubtitles };
