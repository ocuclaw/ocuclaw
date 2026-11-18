const { createModelSiteHttp, ModelSiteError, modelSiteSafeText, modelSiteSecretFree } = require("./sketchfab-client.cjs");
const { isForbiddenHttpDestination } = require("../glasses-ui-recipes.cjs");
const { MODEL_MAX_BYTES } = require("../liveui-pictures/picture-fetch.cjs");
const { modelSiteLabel, sanitizeModelSource } = require("../liveui-pictures/model-source.cjs");

const numericId = (value         )                => {
  const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === "string" && /^[1-9][0-9]{0,15}$/.test(id) ? id : null;
};

function printSiteModelId(src        , site           )                {
  try {
    const url = new URL(src);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || ![`${site}.com`, `www.${site}.com`].includes(url.hostname)) return null;
    const match = site === "thingiverse" ? /^\/thing:([1-9][0-9]{0,15})\/?$/.exec(url.pathname)
      : /^\/(?:[a-z]{2}\/)?object\/3d-print-(?:[^/]*-)?([1-9][0-9]{0,15})\/?$/.exec(url.pathname);
    return match?.[1] || null;
  } catch { return null; }
}

function createPrintSiteClient(options                        , site           ) {
  const http = createModelSiteHttp(options, site);
  const base = site === "thingiverse" ? "/things" : "/api/v2/objects";
  const label = modelSiteLabel(site);
  return {
    async account(token        , reach                , signal             )                            {
      const row = await http.json(site === "thingiverse" ? "/users/me" : "/api/v2/user", token, reach, signal);
      const id = site === "thingiverse" ? numericId(row.id) : row.username;
      if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(id) || !modelSiteSecretFree(id, token)) throw new ModelSiteError("provider_unavailable");

      const name = modelSiteSafeText(row.name || row.username, 160, token) || `${label} account`;
      return { id, name };
    },
    async download(id        , token        , reach                , signal             )                                                     {
      if (!numericId(id) || !modelSiteSecretFree(id, token)) throw new ModelSiteError("invalid_request");
      const model = await http.json(`${base}/${id}`, token, reach, signal);
      if (numericId(model.id) !== id) throw new ModelSiteError("download_unavailable");
      const listing = await http.json(`${base}/${id}/files`, token, reach, signal);
      const files = site === "thingiverse" ? listing : listing.items;
      if (!Array.isArray(files)) throw new ModelSiteError("provider_unavailable");

      const supported = files.filter(file => file && /\.(?:stl|obj|glb|gltf|3mf|ply)$/i.test(file.name || file.filename || ""));
      if (!supported.length) throw new ModelSiteError("unsupported_format");
      const file = supported.find(file => typeof file.download_url === "string" && file.download_url
        && (!Number.isFinite(Number(file.size)) || Number(file.size) <= MODEL_MAX_BYTES));
      if (!file) throw new ModelSiteError(supported.every(file => Number(file.size) > MODEL_MAX_BYTES) ? "too_large" : "download_unavailable");
      let url     ;
      try { url = new URL(file.download_url); } catch { throw new ModelSiteError("provider_unavailable"); }
      if (site === "thingiverse" && url.origin === "https://api.thingiverse.com") {
        const fileId = numericId(file.id);
        if (!fileId || url.pathname !== `/files/${fileId}/download` || url.search || url.hash || url.username || url.password) throw new ModelSiteError("network_policy");
        const redirect = await http.json(`/files/${fileId}/download`, token, reach, signal);
        try { url = new URL(redirect.downloadUrl); } catch { throw new ModelSiteError("download_unavailable"); }
      }
      if (url.protocol !== "https:" || url.username || url.password || url.port
        || !modelSiteSecretFree(url.toString(), token) || isForbiddenHttpDestination(url.toString())) throw new ModelSiteError("network_policy");
      const title = modelSiteSafeText(model.name, 200, token) || `${label} model`;
      const creator = modelSiteSafeText((model.creator || model.designer)?.name || model.designer?.username, 160, token) || "Unknown creator";
      const license = modelSiteSafeText(model.license, 160, token) || "Unknown licence";
      const modelSource = sanitizeModelSource({ provider: site, modelId: id, title, creator, license,
        attribution: `${title} by ${creator}. ${license}.` })               ;
      return { url: url.toString(), modelSource };
    },
    close: http.close,
  };
}

module.exports = { printSiteModelId, createPrintSiteClient };
