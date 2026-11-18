const { Buffer } = require("node:buffer");
const { fetch: undiciFetch } = require("undici");
const { createSsrfSafeDispatcher, isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");
const { MODEL_MAX_BYTES } = require("../liveui-pictures/picture-fetch.cjs");
const { modelSourceText, modelSourceLink, sanitizeModelSource } = require("../liveui-pictures/model-source.cjs");

function modelSiteSecretFree(value         , token        )          {
  if (typeof value !== "string" || !token) return true;
  if (value.includes(token)) return false;
  try { return !decodeURIComponent(value).includes(token); } catch { return true; }
}
function modelSiteSafeText(value         , max        , token        )         {
  return modelSourceText(modelSiteSecretFree(value, token) ? value : "[redacted]", max);
}
class ModelSiteError extends Error {
  code        ;

  committed = false;
  constructor(code        ) { super(code); this.code = code; }
}

function sketchfabModelId(src        )                {
  try {
    const u = new URL(src);
    if (u.protocol !== "https:" || u.username || u.password || u.port || !["sketchfab.com", "www.sketchfab.com"].includes(u.hostname)) return null;
    const match = /^\/(?:3d-models|models)\/(?:[^/]*-)?([0-9a-f]{32})(?:\/embed)?\/?$/i.exec(u.pathname);
    return match ? match[1].toLowerCase() : null;
  } catch { return null; }
}

function modelSiteRace   (promise            , signal             )             {
  if (signal.aborted) return Promise.reject(new ModelSiteError("cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new ModelSiteError("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function guardRefused(error         )          {
  const seen = new Set         ();
  const pending            = [error];
  while (pending.length && seen.size < 16) {
    const e = pending.shift()       ;
    if (!e || typeof e !== "object" || seen.has(e)) continue;
    seen.add(e);
    if (typeof e.message === "string" && e.message.includes("SSRF guard")) return true;
    if (e.cause) pending.push(e.cause);
    if (Array.isArray(e.errors)) pending.push(...e.errors);
  }
  return false;
}

function createModelSiteHttp(options                        , site                                               ) {
  const host = site === "sketchfab" ? "api.sketchfab.com" : site === "thingiverse" ? "api.thingiverse.com" : "www.myminifactory.com";
  const accountPath = site === "sketchfab" ? "/v3/me" : site === "thingiverse" ? "/users/me" : "/api/v2/user";
  const routes = site === "sketchfab" ? /^\/v3\/(?:me|models\/[0-9a-f]{32}(?:\/download)?)$/
    : site === "thingiverse" ? /^\/(?:users\/me|things\/[1-9][0-9]{0,15}(?:\/files)?|files\/[1-9][0-9]{0,15}\/download)$/
    : /^\/api\/v2\/(?:user|objects\/[1-9][0-9]{0,15}(?:\/files)?|files\/[1-9][0-9]{0,15})$/;
  let ownDispatcher      = null;
  function network(reach                ) {
    if (options.httpEnabled() !== true) throw new ModelSiteError("network_policy");
    if (reach === "hosts") {
      let allowed = false;
      try { allowed = options.hostCheck()?.(host) === "listed"; } catch {  }
      if (!allowed) throw new ModelSiteError("network_policy");
    }
  }
  async function json(endpoint        , token        , reach                , outer             )               {
    network(reach);

    if (!routes.test(endpoint)) throw new ModelSiteError("invalid_request");
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", abort, { once: true });
    const timeout = Math.min(8000, Math.max(1, options.timeoutMs || 8000));
    const timer = setTimeout(abort, timeout);
    const cap = Math.min(1024 * 1024, Math.max(1, options.maxBytes || 1024 * 1024));
    let response     ;
    let reader     ;
    try {
      if (controller.signal.aborted) throw new ModelSiteError("cancelled");
      const dispatcher = options.dispatcher !== undefined ? options.dispatcher : (ownDispatcher ||= createSsrfSafeDispatcher());
      const fetch = options.fetch || undiciFetch                                                           ;
      response = await modelSiteRace(Promise.resolve(fetch(`https://${host}${endpoint}`, {
        method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal,

        headers: { ...(token ? { Authorization: `${site === "sketchfab" ? "Token" : "Bearer"} ${token}` } : {}), Accept: "application/json", "User-Agent": "OcuClaw-ModelSites/1" },
        ...(dispatcher ? { dispatcher } : {}),
      })), controller.signal);

      const status = Number(response?.status);
      if (site === "thingiverse" && /^\/files\/[1-9][0-9]{0,15}\/download$/.test(endpoint)
        && [301, 302, 303, 307, 308].includes(status)) {

        return { downloadUrl: response.headers?.get?.("location") };
      }
      if (status === 401 || endpoint === accountPath && status === 403) throw new ModelSiteError("invalid_token");
      if (status === 403 || status === 404) throw new ModelSiteError("download_unavailable");
      if (status === 429) throw new ModelSiteError("rate_limited");
      if (status !== 200) throw new ModelSiteError("provider_unavailable");
      const length = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(length) && length > cap) throw new ModelSiteError("provider_unavailable");
      reader = response.body?.getReader?.();
      if (!reader) throw new ModelSiteError("provider_unavailable");
      const chunks           = [];
      let size = 0;
      for (;;) {
        const row      = await modelSiteRace(Promise.resolve(reader.read()), controller.signal);
        if (row.done) break;
        size += row.value.byteLength;
        if (size > cap) throw new ModelSiteError("provider_unavailable");
        chunks.push(Buffer.from(row.value));
      }
      const result = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
      if (!result || typeof result !== "object" || (Array.isArray(result) && !(site === "thingiverse" && endpoint.endsWith("/files")))) throw new ModelSiteError("provider_unavailable");
      return result;
    } catch (error) {
      if (outer.aborted) throw new ModelSiteError("cancelled");
      if (guardRefused(error)) throw new ModelSiteError("network_policy");
      if (error instanceof ModelSiteError && !controller.signal.aborted) throw error;

      throw new ModelSiteError("provider_unavailable");
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", abort);
      controller.abort();
      try { Promise.resolve(reader ? reader.cancel() : response?.body?.cancel?.()).catch(() => {}); } catch {  }
    }
  }
  return { json, close() { if (ownDispatcher) { void ownDispatcher.close(); ownDispatcher = null; } } };
}

function sketchfabModelSource(id        , model     , token        )              {
  const text = modelSiteSafeText;
  const title = text(model.name, 200, token) || "Sketchfab model";
  const creator = text(model.user?.displayName || model.user?.username, 160, token) || "Unknown creator";
  const license = text(model.license?.label || model.license?.fullName, 160, token) || "Unknown licence";
  return sanitizeModelSource({ provider: "sketchfab", modelId: id, title,
    creator, creatorUrl: modelSiteSecretFree(model.user?.profileUrl, token) ? modelSourceLink(model.user?.profileUrl) : undefined, license,
    licenseUrl: modelSiteSecretFree(model.license?.url, token) ? modelSourceLink(model.license?.url, true) : undefined,
    attribution: `${title} by ${creator}. ${license}.` })               ;
}

function createSketchfabClient(options                        ) {
  const http = createModelSiteHttp(options, "sketchfab");
  const { json } = http;
  const text = modelSiteSafeText;
  return {
    async account(token        , reach                , signal             )                            {
      const r = await json("/v3/me", token, reach, signal);
      if (typeof r.uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.uid) || !modelSiteSecretFree(r.uid, token)) throw new ModelSiteError("provider_unavailable");
      const url = typeof r.username === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(r.username) && modelSiteSecretFree(r.username, token)
        ? `https://sketchfab.com/${r.username}` : undefined;
      return { id: r.uid, name: text(r.displayName || r.username, 160, token) || "Sketchfab account", ...(url ? { url } : {}) };
    },
    async download(id        , token        , reach                , signal             )                                                     {
      if (!modelSiteSecretFree(id, token)) throw new ModelSiteError("provider_unavailable");
      const model = await json(`/v3/models/${id}`, token, reach, signal);
      if (model.uid !== id || model.isDownloadable !== true) throw new ModelSiteError("download_unavailable");
      const files = await json(`/v3/models/${id}/download`, token, reach, signal);
      const file = [files.glb, files.gltf].find(f => f && typeof f.url === "string" && (!Number.isFinite(f.size) || f.size <= MODEL_MAX_BYTES));
      if (!file) throw new ModelSiteError([files.glb, files.gltf].some(f => f && Number.isFinite(f.size) && f.size > MODEL_MAX_BYTES) ? "too_large" : "unsupported_format");
      let url     ;
      try { url = new URL(file.url); } catch { throw new ModelSiteError("provider_unavailable"); }
      if (url.protocol !== "https:" || url.username || url.password || !modelSiteSecretFree(file.url, token)
        || isForbiddenHttpDestination(url.toString())) throw new ModelSiteError("network_policy");
      return { url: url.toString(), modelSource: sketchfabModelSource(id, model, token) };
    },

    async publicSource(id        , reach                , signal             )                       {
      const model = await json(`/v3/models/${id}`, "", reach, signal);
      if (model.uid !== id) throw new ModelSiteError("download_unavailable");
      return sketchfabModelSource(id, model, "");
    },
    close: http.close,
  };
}

module.exports = { modelSiteSecretFree, modelSiteSafeText, ModelSiteError, sketchfabModelId, modelSiteRace, createModelSiteHttp, createSketchfabClient };
