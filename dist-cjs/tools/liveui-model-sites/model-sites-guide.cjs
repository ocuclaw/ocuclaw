const { MODEL_SITE_PROVIDERS, modelSiteLabel } = require("../liveui-pictures/model-source.cjs");

const MODEL_SITES_FENCE_KIND = "liveui_model_sites";

const SIGNED_IN = new Set(["connected", "temporarily_unavailable"]);

const FREE_SOURCES = "any model you can reach without a login, searched widely: a direct model file link "
  + "(.glb .gltf .obj .stl .3mf .ply, or a zip of one) from any site, a model file you downloaded shown by its path "
  + "(Printables and MakerWorld work this way), or a model page you found on GitHub, Smithsonian 3D (3d.si.edu) "
  + "or NASA 3D Resources (science.nasa.gov/3d-resources)";

const NO_CONNECT_ASK = "Never tell the wearer to connect a model site unless they ask how.";

function joined(names          )         {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function modelSitesGuideLine(
  status                                                                                                             ,
  options                                = {},
)                {
  if (typeof status !== "function") return null;
  const on           = [];
  const off           = [];
  let read = 0;
  for (const site of MODEL_SITE_PROVIDERS) {
    let row                                                           ;
    try { row = status(site); } catch { row = undefined; }
    const state = row?.state;

    if (typeof state !== "string" || state === "checking" || state === "temporarily_unavailable" && !row?.account) continue;
    read += 1;
    (SIGNED_IN.has(state) ? on : off).push(modelSiteLabel(site));
  }
  if (read === 0) return null;

  const mirrored = options.sketchfabMirror === true && off.includes(modelSiteLabel("sketchfab"));
  if (mirrored) off.splice(off.indexOf(modelSiteLabel("sketchfab")), 1);
  const mirrorLine = mirrored
    ? "Sketchfab is not connected, but a free downloadable Sketchfab model's page (most from before 2023) still shows through a public mirror; "

      + "a model that is not downloadable never shows, so find downloadable ones with "
      + "https://api.sketchfab.com/v3/search?type=models&downloadable=true&max_face_count=500000&sort_by=-likeCount&q=<words> "
      + "and use the top result's viewerUrl. "
    : "";
  if (on.length === 0) {
    const offLine = off.length
      ? `${joined(off)} ${off.length === 1 ? "is" : "are"} not connected, so ${off.length === 1 ? "its" : "their"} pages will not show. `
      : "";
    return `3D model sites: ${offLine}${mirrorLine}`
      + `For a 3D model, use ${FREE_SOURCES}; if none matches, show the closest free model and say what it is. `
      + NO_CONNECT_ASK;
  }
  const offPart = off.length ? `; ${joined(off)} ${off.length === 1 ? "is" : "are"} not` : "";
  return `3D model sites: ${joined(on)} ${on.length === 1 ? "is" : "are"} connected${offPart}. ${mirrorLine}`
    + `For a 3D model, look on ${on.length === 1 ? "that site" : "those sites"} first and use the model's page in inline records (never in a card); `
    + `if nothing fits, use ${FREE_SOURCES}.`
    + (off.length ? " Never use a page from a site that is not connected." : "")
    + (off.length || mirrored ? ` ${NO_CONNECT_ASK}` : "");
}

module.exports = { MODEL_SITES_FENCE_KIND, modelSitesGuideLine };
