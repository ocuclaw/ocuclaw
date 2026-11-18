const MODEL_SITE_PROVIDERS = ["sketchfab", "thingiverse", "myminifactory"]         ;

function modelSiteProvider(value         )                             {
  return MODEL_SITE_PROVIDERS.includes(value                     );
}
function modelSiteLabel(provider                   )         {
  return { sketchfab: "Sketchfab", thingiverse: "Thingiverse", myminifactory: "MyMiniFactory" }[provider];
}
function modelSitePage(provider                   , id        )         {
  return provider === "sketchfab" ? `https://sketchfab.com/3d-models/${id}`
    : provider === "thingiverse" ? `https://www.thingiverse.com/thing:${id}` : `https://www.myminifactory.com/object/3d-print-${id}`;
}

function modelSourceText(value         , max        )         {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function modelSourceLink(value         , license = false)                     {
  if (typeof value !== "string" || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    const sites = ["sketchfab.com", "www.thingiverse.com", "www.myminifactory.com"];
    const hosts = license ? [...sites, "creativecommons.org", "www.creativecommons.org"] : sites;
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)
      || url.search || url.hash) return undefined;
    return url.toString();
  } catch { return undefined; }
}

function sanitizeModelSource(raw         )                          {
  const r = raw       ;
  if (!r || !modelSiteProvider(r.provider) || typeof r.modelId !== "string"
    || !(r.provider === "sketchfab" ? /^[0-9a-f]{32}$/ : /^[1-9][0-9]{0,15}$/).test(r.modelId)) return undefined;
  const creatorUrl = modelSourceLink(r.creatorUrl);
  const licenseUrl = modelSourceLink(r.licenseUrl, true);
  return {
    provider: r.provider, modelId: r.modelId,
    title: modelSourceText(r.title, 200) || `${modelSiteLabel(r.provider)} model`,
    url: modelSitePage(r.provider, r.modelId),
    creator: modelSourceText(r.creator, 160) || "Unknown creator",
    ...(creatorUrl ? { creatorUrl } : {}),
    license: modelSourceText(r.license, 160) || "Unknown licence",
    ...(licenseUrl ? { licenseUrl } : {}),
    attribution: modelSourceText(r.attribution, 1000),
  };
}

module.exports = { MODEL_SITE_PROVIDERS, modelSiteProvider, modelSiteLabel, modelSitePage, modelSourceText, modelSourceLink, sanitizeModelSource };
