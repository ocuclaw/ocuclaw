const { MODEL_SITE_PROVIDERS, modelSiteLabel } = require("./model-source.cjs");

const GLASS_MESH_TYPE = "model/x-ocuclaw-glass-mesh";

const MODEL_PICTURE_CODES           = [
  "model_format_unsupported",
  "model_too_big",
  "model_unreadable",
  "model_empty",

  "model_needs_login",
  "model_needs_download",
  "model_needs_reconnect",
  "model_download_unavailable",
  "model_rate_limited",
  "model_provider_unavailable",
  "model_scope_refused",
  "model_import_cancelled",
];

const REFUSED_NAMES = new Set(["FBX", "Blend", "USD", "USDZ", "STEP", "Collada", "glTF 1"]);

const MODEL_PAGE_EMPTY = "page";

const CONNECTED_SITES = new Set        (MODEL_SITE_PROVIDERS.map(modelSiteLabel));

const MODEL_PAGE_THINGIVERSE_LINK = "Thingiverse link";
const MODEL_PAGE_MYMINIFACTORY_LINK = "MyMiniFactory link";

const PICK_ANOTHER = "use a connected site or a direct model file link";

const LOGIN_SITES = ["MakerWorld", "Printables"];

function modelFailureSite(code        , detail        )                {
  if (!MODEL_PICTURE_CODES.includes(code) || typeof detail !== "string") return null;
  return CONNECTED_SITES.has(detail) || LOGIN_SITES.includes(detail) ? detail : null;
}

const PAGE_SITE_WORDS = new Map                ([

  ...[...CONNECTED_SITES].map((site)                   => [site, `${site} is not connected: ${PICK_ANOTHER}`]),
  [MODEL_PAGE_THINGIVERSE_LINK, "use the model's main page link: thingiverse.com/thing:<number>"],
  [MODEL_PAGE_MYMINIFACTORY_LINK, "use the model's main page link: myminifactory.com/object/3d-print-<name>-<number>"],
  ["MakerWorld", "MakerWorld needs a login: download the STL or 3MF and show it by its path"],
  ["Printables", "Printables: download the STL or 3MF and show it by its path"],
]);

function connectedSite(detail        )                {
  return CONNECTED_SITES.has(detail) ? detail : null;
}

function modelRefusedFormat(detail        )                {
  return REFUSED_NAMES.has(detail) ? detail : null;
}

function modelFailureDetail(code        , detail        )         {
  switch (code) {
    case "model_format_unsupported":
      return REFUSED_NAMES.has(detail) ? `${detail} model not supported` : "model type not supported";
    case "model_too_big":
      return "model too big";
    case "model_empty":
      return "model has nothing to draw";
    case "model_needs_login":
      return PAGE_SITE_WORDS.get(detail) || "that site needs a login: download the file and show it by its path";
    case "model_needs_download":
      return PAGE_SITE_WORDS.get(detail) || "download the STL or 3MF and show it by its path";
    case "model_needs_reconnect": {
      const site = connectedSite(detail);
      return `${site || "the model site"} needs reconnecting: ${PICK_ANOTHER}`;
    }
    case "model_download_unavailable": {
      const site = connectedSite(detail);
      return `${site || "the model site"} does not permit this model's download`;
    }
    case "model_rate_limited": {
      const site = connectedSite(detail);
      return `${site || "model site"} rate limit reached; try again later`;
    }
    case "model_provider_unavailable": {
      const site = connectedSite(detail);
      return `${site || "the model site"} is temporarily unavailable; try again later`;
    }
    case "model_scope_refused": return "connected model sites need a direct request from the wearer";
    case "model_import_cancelled": return "model import cancelled; check the connected account and retry";
    default:
      return detail === MODEL_PAGE_EMPTY ? "no model file on that page" : "model unreadable";
  }
}

module.exports = { GLASS_MESH_TYPE, MODEL_PICTURE_CODES, MODEL_PAGE_EMPTY, MODEL_PAGE_THINGIVERSE_LINK, MODEL_PAGE_MYMINIFACTORY_LINK, modelFailureSite, modelRefusedFormat, modelFailureDetail };
