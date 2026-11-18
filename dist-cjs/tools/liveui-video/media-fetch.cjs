const { Buffer } = require("node:buffer");
const { fetch: undiciFetch } = require("undici");
const { createSsrfSafeDispatcher, isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");
const { createVideoSubtitleFetch } = require("./video-subtitle-fetch.cjs");

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const PUBLIC_HEADERS = new Set(["accept", "accept-language", "range", "user-agent", "if-range", "if-modified-since", "if-none-match"]);

function mediaRequestHeaders(headers                        , crossed         )                         {
  return Object.fromEntries(Object.entries(headers).filter(([name]) =>
    !["host", "proxy-authorization", "proxy-connection", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer"].includes(name.toLowerCase()) &&
    (!crossed || PUBLIC_HEADERS.has(name.toLowerCase()))));
}

function createMediaFetch(options                                                                                     = {}) {
  const dispatcher = createSsrfSafeDispatcher(options.lookup);

  const routed = options.proxy === undefined ? null : createVideoSubtitleFetch({ lookup: options.lookup });
  const fetchMedia = async (url        , headers                        , signal              )               => {
    let current = new URL(url);
    const origin = current.origin;
    let crossed = false;
    for (let hop = 0; hop <= 5; hop++) {
      if (!["http:", "https:"].includes(current.protocol) || current.username || current.password || isForbiddenHttpDestination(current.href)) {
        throw new Error("Media destination is not public HTTP");
      }
      crossed ||= current.origin !== origin;
      const forwarded = mediaRequestHeaders(headers, crossed);
      const response = routed
        ? await routed(current.href, { headers: forwarded, signal: signal || new AbortController().signal, redirect: "manual", proxy: options.proxy || null })
        : await undiciFetch(current, { headers: forwarded, signal, redirect: "manual", dispatcher });
      if (!REDIRECTS.has(response.status)) {

        Object.defineProperty(response, "mediaUrl", { value: current.href });
        return response;
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hop === 5) throw new Error("Media redirect limit reached");
      current = new URL(location, current);
    }
    throw new Error("Media redirect limit reached");
  };
  return Object.assign(fetchMedia, { close: () => dispatcher.destroy() });
}

const fetchMedia = createMediaFetch();

async function readMediaBody(response     , maxBytes        )                  {
  const reader = response.body?.getReader();
  const chunks           = [];
  let size = 0;
  try {
    if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Media body too large");
    if (!reader) throw new Error("Media body unavailable");
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Media body too large");
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader?.cancel(); } catch {  }
    throw error;
  } finally { reader?.releaseLock(); }
}

module.exports = { mediaRequestHeaders, createMediaFetch, fetchMedia, readMediaBody };
