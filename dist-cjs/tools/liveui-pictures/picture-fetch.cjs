const { Buffer } = require("node:buffer");
const { fetch: undiciFetch } = require("undici");
const { createSsrfSafeDispatcher, isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");

const { pictureLooksLike, sniffPicture } = require("./picture-sniff.cjs");

function isPictureCopy(value         )                       {
  return value === "render" || value === "small";
}

const PICTURE_FETCH_TIMEOUT_MS = 8000;
const PICTURE_MAX_BYTES = 4 * 1024 * 1024;
const PICTURE_MAX_REDIRECTS = 3;

const MODEL_FETCH_TIMEOUT_MS = 20_000;

const MODEL_MAX_BYTES = 32 * 1024 * 1024;

const MODEL_MAX_RESOURCES = 16;

const MODEL_RESOURCE_ACCEPT = "application/octet-stream,*/*;q=0.1";

const PICTURE_HEAD_BYTES = 4096;
const PICTURE_USER_AGENT = "OcuClaw-LiveUI-Picture/1 (+https://github.com/OcuClawhub/evenclaw)";
const PICTURE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,*/*;q=0.1";

const PICTURE_COPY_WIDTH = 500;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const WIKIMEDIA_THUMB_WIDTHS                    = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];

function standardWikimediaThumbUrl(urlText        )                {
  let url     ;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "upload.wikimedia.org") return null;
  const m = /^(\/[a-z]+\/[a-z0-9-]+\/thumb\/([0-9a-f])\/\2[0-9a-f]\/[^/]+\/)([0-9]+)px-([^/]+)$/i.exec(url.pathname);
  if (!m) return null;
  const asked = Number(m[3]);
  if (!(asked > 0) || WIKIMEDIA_THUMB_WIDTHS.includes(asked)) return null;
  const fits = WIKIMEDIA_THUMB_WIDTHS.filter((w) => w <= asked);
  const width = fits.length > 0 ? fits[fits.length - 1] : WIKIMEDIA_THUMB_WIDTHS[0];
  url.pathname = `${m[1]}${width}px-${m[4]}`;
  return url.toString();
}

function wikimediaRenderUrl(urlText        )                {
  let url     ;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "upload.wikimedia.org") return null;
  const m = /^\/([a-z]+\/[a-z0-9-]+)\/([0-9a-f])\/(\2[0-9a-f])\/([^/]+\.svg)$/i.exec(url.pathname);
  if (!m) return null;
  return `https://upload.wikimedia.org/${m[1]}/thumb/${m[2]}/${m[3]}/${m[4]}/${PICTURE_COPY_WIDTH}px-${m[4]}.png`;
}

function smallCopyUrl(urlText        )                {
  let url     ;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname === "upload.wikimedia.org") {
    const m = /^\/([a-z]+\/[a-z0-9-]+)\/([0-9a-f])\/(\2[0-9a-f])\/([^/]+\.(?:jpe?g|png|gif))$/i.exec(url.pathname);
    if (!m) return null;
    return `https://upload.wikimedia.org/${m[1]}/thumb/${m[2]}/${m[3]}/${m[4]}/${PICTURE_COPY_WIDTH}px-${m[4]}`;
  }
  if (url.hostname === "images.unsplash.com") {
    if (url.searchParams.get("w") === String(PICTURE_COPY_WIDTH)) return null;

    url.searchParams.delete("h");
    url.searchParams.delete("dpr");
    url.searchParams.set("w", String(PICTURE_COPY_WIDTH));
    return url.toString();
  }
  return null;
}

const PICTURE_LARGE_WIDTH = 1920;

function largerCopyUrls(urlText        )           {
  let url     ;
  try {
    url = new URL(urlText);
  } catch {
    return [];
  }
  if (url.protocol !== "https:") return [];
  if (url.hostname === "upload.wikimedia.org") {
    const base = "https://upload.wikimedia.org";
    const thumb = /^\/([a-z]+\/[a-z0-9-]+)\/thumb\/([0-9a-f])\/(\2[0-9a-f])\/([^/]+)\/([0-9]+)px-([^/]+)$/i.exec(url.pathname);
    if (thumb) {
      const [, prefix, h, hh, name, width, rest] = thumb;
      if (Number(width) >= PICTURE_LARGE_WIDTH) return [];
      const render = `${base}/${prefix}/thumb/${h}/${hh}/${name}/${PICTURE_LARGE_WIDTH}px-${rest}`;
      if (/\.(?:jpe?g|png|gif)$/i.test(name)) return [`${base}/${prefix}/${h}/${hh}/${name}`, render];
      if (/\.svg$/i.test(name)) return [render];
      return [];
    }
    const original = /^\/([a-z]+\/[a-z0-9-]+)\/([0-9a-f])\/(\2[0-9a-f])\/([^/]+\.(jpe?g|png|gif|svg))$/i.exec(url.pathname);
    if (!original) return [];
    const [, prefix, h, hh, name, ext] = original;
    const suffix = ext.toLowerCase() === "svg" ? ".png" : "";
    return [`${base}/${prefix}/thumb/${h}/${hh}/${name}/${PICTURE_LARGE_WIDTH}px-${name}${suffix}`];
  }
  if (url.hostname === "images.unsplash.com") {
    const asked = url.searchParams.get("w");
    if (asked === null) {

      url.searchParams.delete("h");
      url.searchParams.delete("dpr");
      url.searchParams.set("w", String(PICTURE_LARGE_WIDTH));
      return [url.toString()];
    }
    if (!/^[0-9]{1,5}$/.test(asked) || Number(asked) >= PICTURE_LARGE_WIDTH || Number(asked) === 0) return [];

    const tall = url.searchParams.get("h");
    if (tall !== null && /^[0-9]{1,5}$/.test(tall) && Number(tall) > 0) {
      url.searchParams.set("h", String(Math.round((Number(tall) * PICTURE_LARGE_WIDTH) / Number(asked))));
    } else {
      url.searchParams.delete("h");
    }
    url.searchParams.delete("dpr");
    url.searchParams.set("w", String(PICTURE_LARGE_WIDTH));
    return [url.toString()];
  }
  return [];
}

let sharedDispatcher          = null;
function guardedDispatcher()          {
  if (!sharedDispatcher) sharedDispatcher = createSsrfSafeDispatcher();
  return sharedDispatcher;
}

function failure(code        , detail        , seen              )                       {
  return seen ? { ok: false, code, detail, seen } : { ok: false, code, detail };
}

const HOST_REFUSED = ()                 => ({ ok: false, code: "picture_host_refused", detail: "host refused" });

function checkHop(urlText        , opts                     )                        {
  let url     ;
  try {
    url = new URL(urlText);
  } catch {
    return HOST_REFUSED();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return HOST_REFUSED();
  if (url.username || url.password) return HOST_REFUSED();
  if (isForbiddenHttpDestination(url.toString())) return HOST_REFUSED();
  if (opts.reach !== "wearer") {
    let verdict = "";
    try {
      verdict = typeof opts.hostCheck === "function" ? String(opts.hostCheck(url.hostname)) : "";
    } catch {
      verdict = "";
    }
    if (verdict !== "listed") return HOST_REFUSED();
  }
  return null;
}

function isGuardRefusal(err         )          {
  const seen = new Set         ();
  const queue            = [err];
  while (queue.length && seen.size < 16) {
    const e = queue.shift()       ;
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    if (typeof e.message === "string" && e.message.includes("SSRF guard")) return true;
    if (e.cause) queue.push(e.cause);
    if (Array.isArray(e.errors)) queue.push(...e.errors);
  }
  return false;
}

class AbortedRace extends Error {}

function raceAbort   (promise            , signal             )             {
  if (signal.aborted) return Promise.reject(new AbortedRace("aborted"));
  return new Promise   ((resolve, reject) => {
    const onAbort = () => reject(new AbortedRace("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function cancelBody(response     )       {
  try {
    const body = response && response.body;
    if (body && typeof body.cancel === "function") body.cancel().catch(() => {});
  } catch {

  }
}

const positive = (value         , fallback        )         =>
  Number.isFinite(value) && (value          ) > 0 ? (value          ) : fallback;

function startRun(outer                         , timeoutMs        )           {
  const controller = new AbortController();
  const started = Date.now();
  let deadline = started + timeoutMs;
  let timedOut = false;
  const onTime = () => {
    timedOut = true;
    controller.abort();
  };
  let timer = setTimeout(onTime, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    started,
    abort: () => controller.abort(),
    timedOut: () => timedOut,
    deadline: () => deadline,
    extend(totalMs) {
      const next = started + totalMs;
      if (timedOut || next <= deadline) return;
      clearTimeout(timer);
      deadline = next;
      timer = setTimeout(onTime, Math.max(0, next - Date.now()));
    },
    limit(totalMs) {
      if (timedOut) return;
      clearTimeout(timer);
      deadline = started + totalMs;
      const left = deadline - Date.now();
      if (left <= 0) onTime();
      else timer = setTimeout(onTime, left);
    },
    end() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onOuterAbort);
    },
  };
}

function caughtFailure(err         , run          , outer                         )                 {
  if (run.timedOut()) return { ok: false, code: "picture_fetch_failed", detail: "timeout" };
  if (outer && outer.aborted) return { ok: false, code: "picture_fetch_failed", detail: "cancelled" };
  if (isGuardRefusal(err)) return HOST_REFUSED();
  return { ok: false, code: "picture_fetch_failed", detail: "network" };
}

async function openHops(
  url        ,
  opts                     ,
  run          ,
  accept        ,
)                                                           {
  const maxRedirects = Number.isInteger(opts.maxRedirects) && (opts.maxRedirects          ) >= 0 ? (opts.maxRedirects          ) : PICTURE_MAX_REDIRECTS;
  const fetchFn = typeof opts.fetch === "function" ? opts.fetch : (undiciFetch                                                        );
  const dispatcher = opts.dispatcher !== undefined ? opts.dispatcher : guardedDispatcher();
  let current = url;
  for (let hop = 0; ; hop++) {

    current = standardWikimediaThumbUrl(current) ?? current;
    const refused = checkHop(current, opts);
    if (refused) return refused;
    const init                          = {
      method: "GET",
      headers: { "User-Agent": PICTURE_USER_AGENT, Accept: accept },
      redirect: "manual",
      credentials: "omit",
      signal: run.signal,
    };
    if (dispatcher) init.dispatcher = dispatcher;
    const response = await raceAbort(Promise.resolve(fetchFn(current, init)), run.signal);
    const status = Number(response && response.status);
    if (REDIRECT_STATUSES.has(status)) {
      const location = response.headers && typeof response.headers.get === "function" ? response.headers.get("location") : null;
      cancelBody(response);
      if (!location) return { ok: false, code: "picture_fetch_failed", detail: `http ${status}` };
      if (hop >= maxRedirects) return { ok: false, code: "picture_fetch_failed", detail: "too many redirects" };
      try {
        current = new URL(location, current).toString();
      } catch {
        return HOST_REFUSED();
      }
      continue;
    }
    if (!(status >= 200 && status < 300)) {
      cancelBody(response);
      return { ok: false, code: "picture_fetch_failed", detail: `http ${Number.isFinite(status) ? status : 0}` };
    }
    return { response, url: current };
  }
}

function declaredLength(response     )                {
  const declared = response.headers && typeof response.headers.get === "function" ? response.headers.get("content-length") : null;
  if (declared === null || declared === undefined || !/^\d+$/.test(String(declared).trim())) return null;
  return Number(declared);
}

async function readBody(
  response     ,
  signal             ,
  cap              ,
  settle                               ,
  gate           ,
)                                                 {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const buffer = Buffer.from(await raceAbort(response.arrayBuffer()                        , signal));
    if (buffer.length >= PICTURE_HEAD_BYTES) {
      const stop = settle(buffer);
      if (stop) return stop;
    }
    if (buffer.length > cap()) return "too_large";
    if (gate && buffer.length > gate.at) await raceAbort(gate.wait(), signal);
    return buffer;
  }
  const reader = body.getReader();
  const chunks           = [];
  let total = 0;
  let settled = false;
  let stopped = false;
  let gated = false;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read()                                                  , signal);
      if (done) break;
      if (!value) continue;
      total += value.length;
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.length));
      if (!settled && total >= PICTURE_HEAD_BYTES) {
        settled = true;
        const stop = settle(Buffer.concat(chunks, total));
        if (stop) {
          stopped = true;
          return stop;
        }
      }
      if (total > cap()) {
        stopped = true;
        return "too_large";
      }
      if (gate && !gated && total > gate.at) {
        gated = true;
        await raceAbort(gate.wait(), signal);
      }
    }
  } finally {
    if (stopped || signal.aborted) {
      try {
        reader.cancel().catch(() => {});
      } catch {

      }
    }
  }
  return Buffer.concat(chunks, total);
}

function opensPicture(b        )          {
  if (b.length >= 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return true;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  const head = b.toString("latin1", 0, Math.min(b.length, 12));
  if (head.startsWith("GIF8")) return true;
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return true;
  return head.startsWith("BM");
}

function modelResourceUrl(uri        , base        )                {
  if (typeof uri !== "string" || uri.length === 0 || uri.length > 2048) return null;
  let url     ;
  try {
    url = new URL(uri, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.hash = "";
  return url.toString();
}

async function fetchModelResource(
  url        ,
  opts                     ,
  run          ,
  left        ,
  gate          ,
)                                                 {
  const opened = await openHops(url, opts, run, MODEL_RESOURCE_ACCEPT);
  if ("ok" in opened) return opened;
  const declared = declaredLength(opened.response);
  if (declared !== null && declared > left) {
    cancelBody(opened.response);
    return "too_large";
  }
  return readBody(opened.response, run.signal, () => left, () => null, gate);
}

const LFS_POINTER_MAX_BYTES = 1024;
const LFS_VERSION = "version https://git-lfs.github.com/spec/v1\n";
function lfsPointerSize(b        )                {
  if (!Buffer.isBuffer(b) || b.length > LFS_POINTER_MAX_BYTES || b.length < LFS_VERSION.length) return null;
  const text = b.toString("latin1");
  if (!text.startsWith(LFS_VERSION) || !/^oid sha256:[0-9a-f]{64}$/m.test(text)) return null;
  const size = /^size (\d{1,15})$/m.exec(text);
  return size ? Number(size[1]) : null;
}

const uniqueUris = (list         )           =>
  Array.isArray(list) ? [...new Set(list.filter((uri)                => typeof uri === "string"))] : [];

function modelResourcePlan(models                                  , body        )                                   {
  if (!models || typeof models.resourcesOf !== "function") return [];
  let wanted                                                    = null;
  try {
    wanted = models.resourcesOf(body);
  } catch {
    return [];
  }
  const required = uniqueUris(wanted && wanted.required);
  const optional = uniqueUris(wanted && wanted.optional).filter((uri) => !required.includes(uri));
  if (required.length > MODEL_MAX_RESOURCES) return "too_many";
  return [
    ...required.map((uri) => ({ uri, need: true })),
    ...optional.slice(0, MODEL_MAX_RESOURCES - required.length).map((uri) => ({ uri, need: false })),
  ];
}

function fetchPictureUrl(url        , opts                     )                                {
  return fetchPicture(url, opts, true);
}

async function fetchPicture(url        , opts                     , mayCopy         )                                {
  if (!opts || opts.httpEnabled !== true) return failure("picture_source_refused", "web pictures off");
  const timeoutMs = positive(opts.timeoutMs, PICTURE_FETCH_TIMEOUT_MS);
  const pictureMax = positive(opts.maxBytes, PICTURE_MAX_BYTES);
  const models = opts.models && typeof opts.models.sourceOf === "function" ? opts.models : null;
  const modelTimeoutMs = Math.max(timeoutMs, positive(opts.modelTimeoutMs, MODEL_FETCH_TIMEOUT_MS));
  const modelMax = Math.max(pictureMax, positive(opts.modelMaxBytes, MODEL_MAX_BYTES));
  const outer = opts.signal;
  const run = startRun(outer, timeoutMs);

  let raised = false;
  const raise = () => {
    if (raised) return;
    raised = true;
    run.extend(modelTimeoutMs);
  };
  const lower = () => {
    if (!raised) return;
    raised = false;
    run.limit(timeoutMs);
  };
  if (models && opts.model === true) raise();

  const modelGate = typeof opts.modelGate === "function" ? opts.modelGate : null;
  const lane = ()                => (modelGate ? Promise.resolve(modelGate()) : Promise.resolve());

  const fromCopy = async (copyUrl               , copy             , refusal                      )                                => {
    if (!copyUrl || !mayCopy) return refusal;
    const fetched = await fetchPicture(copyUrl, { ...opts, model: false, lfsUrl: undefined, signal: outer, timeoutMs: Math.max(1, run.deadline() - Date.now()) }, false);
    return fetched.ok ? { ...fetched, copy } : refusal;
  };
  const pictureTooLarge = (at        ) => fromCopy(smallCopyUrl(at), "small", failure("picture_too_large", "too large"));
  const overCap = (at        ) => (raised ? Promise.resolve(failure("model_too_big", "")) : pictureTooLarge(at));

  const fromLfs = async (lfsUrl        , size        , at        )                                => {
    if (size > (raised || models ? modelMax : pictureMax)) return await overCap(at);
    const left = (total        ) => Math.max(1, run.started + total - Date.now());
    return fetchPicture(
      lfsUrl,
      { ...opts, lfsUrl: undefined, signal: outer, timeoutMs: left(timeoutMs), modelTimeoutMs: left(modelTimeoutMs) },
      false,
    );
  };

  const withResources = async (model                      , body        , at        )                                => {
    if (!model.ok) return model;
    const wantedNow = modelResourcePlan(models, body);
    if (wantedNow === "too_many") return failure("model_too_big", "");
    if (wantedNow.length === 0) return model;
    raise();
    const resources                         = Object.create(null);
    let held = body.length;
    for (const { uri, need } of wantedNow) {
      const link = modelResourceUrl(uri, at);
      if (!link) {
        if (need) return failure("model_unreadable", "");
        continue;
      }
      let got                                       ;
      try {
        got = await fetchModelResource(link, opts, run, modelMax - held, { at: Math.max(0, pictureMax - held), wait: lane });
      } catch (err) {
        if (need || (outer && outer.aborted)) throw err;
        continue;
      }
      if (got === "too_large") {
        if (need) return failure("model_too_big", "");
        continue;
      }
      if (!Buffer.isBuffer(got)) {
        if (need) return got;
        continue;
      }
      held += got.length;
      resources[uri] = got;
    }
    return Object.keys(resources).length > 0 ? { ...model, resources } : model;
  };
  try {
    const opened = await openHops(url, opts, run, PICTURE_ACCEPT);
    if ("ok" in opened) return opened;
    const { response, url: current } = opened;
    const declared = declaredLength(response);

    if (declared !== null && declared > (raised || models ? modelMax : pictureMax)) {
      if (raised || !models || typeof models.headOf !== "function") {
        cancelBody(response);
        run.abort();
        return await overCap(current);
      }
      let head                = null;
      const read = await readBody(response, run.signal, () => PICTURE_HEAD_BYTES, (h) => {
        head = h;
        return "too_large";
      });
      run.abort();
      const first                = head || (Buffer.isBuffer(read) ? read : null);
      const verdict = first && !opensPicture(first) ? models.headOf(first, declared) : null;
      if (verdict === "model") return failure("model_too_big", "");
      if (verdict && verdict.ok === false) return verdict;
      return await pictureTooLarge(current);
    }

    const settle = (head        )              => {
      if (opensPicture(head)) {
        lower();
        return declared !== null && declared > pictureMax ? "too_large" : null;
      }
      if (models && typeof models.headOf === "function") {
        const verdict = models.headOf(head, declared);
        if (verdict === "model") {
          raise();
          return null;
        }
        if (verdict && verdict.ok === false) return verdict;
      }
      if (raised) return null;
      return declared !== null && declared > pictureMax ? "too_large" : null;
    };
    const body = await readBody(response, run.signal, () => (raised ? modelMax : pictureMax), settle, { at: pictureMax, wait: lane });
    if (body === "too_large") {
      run.abort();
      return await overCap(current);
    }
    if (!Buffer.isBuffer(body)) {
      run.abort();
      return body;
    }
    const sniff = sniffPicture(body);
    if (!sniff.ok) {
      if (sniff.code === "picture_too_large") return await pictureTooLarge(current);
      const pointer = typeof opts.lfsUrl === "string" && mayCopy ? lfsPointerSize(body) : null;
      if (pointer !== null) return await fromLfs(opts.lfsUrl          , pointer, current);
      const model = models ? models.sourceOf(body) : null;
      if (model) return await withResources(model, body, current);

      if (body.length > pictureMax) return await pictureTooLarge(current);
      const seen = pictureLooksLike(body);
      const refusal = failure("picture_type_unsupported", "type not supported", seen);
      return await fromCopy(seen === "svg" ? wikimediaRenderUrl(current) : null, "render", refusal);
    }
    if (body.length > pictureMax) return await pictureTooLarge(current);
    return { ok: true, bytes: body, mime: sniff.mime, type: sniff.type, width: sniff.width, height: sniff.height };
  } catch (err) {
    return caughtFailure(err, run, outer);
  } finally {
    run.end();
  }
}

async function fetchPictureText(url        , opts                     , accept        )                             {
  if (!opts || opts.httpEnabled !== true) return { ok: false, code: "picture_source_refused", detail: "web pictures off" };
  const maxBytes = positive(opts.maxBytes, PICTURE_MAX_BYTES);
  const outer = opts.signal;
  const run = startRun(outer, positive(opts.timeoutMs, PICTURE_FETCH_TIMEOUT_MS));
  const tooLarge = ()                 => ({ ok: false, code: "picture_too_large", detail: "too large" });
  try {
    const opened = await openHops(url, opts, run, accept);
    if ("ok" in opened) return opened;
    const declared = declaredLength(opened.response);
    if (declared !== null && declared > maxBytes) {
      cancelBody(opened.response);
      run.abort();
      return tooLarge();
    }
    const body = await readBody(opened.response, run.signal, () => maxBytes, () => null);
    if (!Buffer.isBuffer(body)) {
      run.abort();
      return tooLarge();
    }
    return { ok: true, text: body.toString("utf8"), url: opened.url };
  } catch (err) {
    return caughtFailure(err, run, outer);
  } finally {
    run.end();
  }
}

module.exports = { isPictureCopy, PICTURE_FETCH_TIMEOUT_MS, PICTURE_MAX_BYTES, PICTURE_MAX_REDIRECTS, MODEL_FETCH_TIMEOUT_MS, MODEL_MAX_BYTES, MODEL_MAX_RESOURCES, MODEL_RESOURCE_ACCEPT, PICTURE_HEAD_BYTES, PICTURE_USER_AGENT, PICTURE_ACCEPT, PICTURE_COPY_WIDTH, WIKIMEDIA_THUMB_WIDTHS, standardWikimediaThumbUrl, wikimediaRenderUrl, smallCopyUrl, PICTURE_LARGE_WIDTH, largerCopyUrls, modelResourceUrl, lfsPointerSize, modelResourcePlan, fetchPictureUrl, fetchPictureText };
