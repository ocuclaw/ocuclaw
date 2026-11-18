const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { Buffer } = require("node:buffer");
const { isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");
const { createMediaFetch, mediaRequestHeaders, readMediaBody } = require("./media-fetch.cjs");
const { rewriteMediaHls } = require("./media-hls.cjs");

async function createMediaRelay(input        , options                    = {})                      {
  options.signal?.throwIfAborted();
  const source = new URL(input);
  if (!["http:", "https:"].includes(source.protocol) || source.username || source.password || isForbiddenHttpDestination(input)) throw new Error("Media destination is not public HTTP");
  const fetchMedia = createMediaFetch({ lookup: options.lookup, ...(options.proxy !== undefined ? { proxy: options.proxy } : {}) });
  const sockets = new Set     (), controllers = new Set                 ();
  let origin = "", closed = false, closing                       = null;
  const resources = new Map                                            (), byUrl = new Map                ();
  let resourceBytes = 0;
  function local(url        , playlist         )         {
    const parsed = new URL(url);
    if (closed || parsed.username || parsed.password || !["http:", "https:"].includes(parsed.protocol) || isForbiddenHttpDestination(url) || Buffer.byteLength(url) > 16384) throw new Error("Media resource refused");
    const key = JSON.stringify([url, playlist]);
    let tokenPath = byUrl.get(key);
    if (!tokenPath) {
      const bytes = 2 * Buffer.byteLength(key) + 256;
      if (resources.size >= 4096 || resourceBytes + bytes > 16 * 1024 * 1024) throw new Error("Media resource limit reached");
      const suffix = playlist ? ".m3u8" : /\.[a-z0-9]{1,8}$/i.exec(parsed.pathname)?.[0] || ".bin";
      tokenPath = `/${randomBytes(24).toString("hex")}/media${suffix}`;
      resources.set(tokenPath, { url, playlist }); byUrl.set(key, tokenPath); resourceBytes += bytes;
    }
    return origin + tokenPath;
  }
  const server = http.createServer({ maxHeaderSize: 16384 }, async (req     , res     ) => {
    const resource = resources.get(req.url);
    if (closed || !resource || req.headers.host !== new URL(origin).host || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404).end(); return; }
    if (controllers.size >= 32) { res.writeHead(503).end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); req.once("aborted", abort); res.once("close", abort);
    try {
      const headers                         = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
      for (const key of ["range", "if-range", "if-none-match", "if-modified-since"]) if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
      for (const key of ["user-agent", "accept", "accept-language"]) if (headers[key] === undefined && typeof req.headers[key] === "string") headers[key] = req.headers[key];
      headers["accept-encoding"] = "identity";
      if (resource.playlist) for (const key of ["range", "if-range", "if-none-match", "if-modified-since"]) delete headers[key];
      const upstream = await fetchMedia(resource.url, mediaRequestHeaders(headers, new URL(resource.url).origin !== source.origin), controller.signal);
      if (upstream.status < 200 || upstream.status >= 300) {
        await upstream.body?.cancel();
        res.writeHead(upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502).end(); return;
      }
      if (closed || controller.signal.aborted) { await upstream.body?.cancel(); return; }
      if (resource.playlist) {
        const bytes = await readMediaBody(upstream, 1024 * 1024);
        const rewritten = rewriteMediaHls(new TextDecoder("utf-8", { fatal: true }).decode(bytes), upstream.mediaUrl, local);
        if (closed || controller.signal.aborted) return;
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "content-length": Buffer.byteLength(rewritten), "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : rewritten); return;
      }
      const forwarded                         = {};
      for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
        const value = upstream.headers.get(key); if (value !== null) forwarded[key] = value;
      }

      if (upstream.headers.get("content-encoding") && upstream.headers.get("content-encoding") !== "identity") delete forwarded["content-length"];
      res.writeHead(upstream.status, forwarded);
      if (req.method === "HEAD") { await upstream.body?.cancel(); res.end(); }
      else await pipeline(Readable.fromWeb(upstream.body), res);
    } catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end(); else res.destroy();
    } finally {
      controller.abort(); controllers.delete(controller);
      req.removeListener("aborted", abort); res.removeListener("close", abort);
    }
  });
  const close = ()                => {
    if (closing) return closing;
    closed = true; options.signal?.removeEventListener("abort", abort);
    resources.clear(); byUrl.clear(); resourceBytes = 0;
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    closing = Promise.allSettled([fetchMedia.close(), new Promise      ((resolve) => server.close(() => resolve()))]).then(() => undefined);
    return closing;
  };
  const abort = () => { void close(); };
  server.requestTimeout = 0; server.timeout = 120000; server.maxConnections = 64;
  server.on("connection", (socket     ) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error       , socket     ) => socket.destroy());
  server.on("error", abort);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    let abortStart                          ;
    await new Promise      ((resolve, reject) => {
      abortStart = () => reject(options.signal?.reason || new Error("Media relay aborted"));
      options.signal?.addEventListener("abort", abortStart, { once: true });
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    }).finally(() => { if (abortStart) options.signal?.removeEventListener("abort", abortStart); });
    options.signal?.throwIfAborted();
    origin = `http://127.0.0.1:${server.address().port}`;
    return { url: local(source.href, options.hls === true), close };
  } catch (error) { await close(); throw error; }
}

module.exports = { createMediaRelay };
