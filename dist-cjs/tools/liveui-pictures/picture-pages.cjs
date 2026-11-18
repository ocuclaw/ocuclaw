const { fetchPictureText } = require("./picture-fetch.cjs");
const { MODEL_PAGE_EMPTY, MODEL_PAGE_MYMINIFACTORY_LINK, MODEL_PAGE_THINGIVERSE_LINK } = require("./picture-model.cjs");

const MODEL_FILE_RE = /\.(?:glb|gltf|obj|stl|3mf|ply)$/i;
const ZIP_FILE_RE = /\.zip$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const SMITHSONIAN_FILE_SEARCH = "https://3d-api.si.edu/api/v1.0/content/file/search";
const PAGE_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";
const JSON_ACCEPT = "application/json,*/*;q=0.1";

const SMITHSONIAN_ANSWER_MAX_BYTES = 1024 * 1024;

const NASA_MAX_VIEWERS = 8;
const NASA_TAG_CHARS = 4096;
const NASA_MAX_LINKS = 1000;

const LOGIN_PAGES                                  = [
  [/^(www\.)?sketchfab\.com$/, /^\/(3d-models|models)\/[^/]/, "Sketchfab"],
  [/^(www\.)?makerworld\.com$/, /^\/([a-z]{2}(-[a-z]{2,4})?\/)?models\/\d+/i, "MakerWorld"],
];

const PRINT_SITE_PAGES                                                  = [
  [/^(www\.)?thingiverse\.com$/, /^\/thing:\d+/, /^\/thing:[1-9][0-9]{0,15}\/?$/, "Thingiverse", MODEL_PAGE_THINGIVERSE_LINK],
  [/^(www\.)?myminifactory\.com$/, /^\/([a-z]{2}\/)?object\/[^/]/,
    /^\/(?:[a-z]{2}\/)?object\/3d-print-(?:[^/]*-)?[1-9][0-9]{0,15}\/?$/, "MyMiniFactory", MODEL_PAGE_MYMINIFACTORY_LINK],
];
const DOWNLOAD_PAGES                                  = [[/^(www\.)?printables\.com$/, /^\/([a-z]{2}\/)?model\/\d+/i, "Printables"]];

function parseHttps(text        )             {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function picturePageOf(src        )                     {
  const url = parseHttps(src);
  if (!url || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === "github.com" || host === "www.github.com" || host === "raw.githubusercontent.com") {

    const m =
      host === "raw.githubusercontent.com"
        ? /^\/([^/]+)\/([^/]+)\/(.+\/[^/]*[^/])$/.exec(path)
        : /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+\/[^/]*[^/])$/.exec(path);
    if (!m) return null;
    return {
      kind: "github",
      url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`,
      model: MODEL_FILE_RE.test(m[3]),
      lfs: `https://media.githubusercontent.com/media/${m[1]}/${m[2]}/${m[3]}`,
    };
  }
  if ((host === "science.nasa.gov" || host === "www.science.nasa.gov") && /^\/3d-resources\/[^/]+\/?$/.test(path)) {
    return { kind: "nasa", url: `https://science.nasa.gov${path}` };
  }
  if (host === "3d.si.edu" || host === "www.3d.si.edu") {
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      decoded = path;
    }
    const ids = decoded.match(UUID_RE);
    return ids ? { kind: "smithsonian", id: ids[ids.length - 1].toLowerCase() } : null;
  }
  for (const [h, p, site] of LOGIN_PAGES) if (h.test(host) && p.test(path)) return { kind: "login", site };
  for (const [h, p, main, site, other] of PRINT_SITE_PAGES) {
    if (!h.test(host) || !p.test(path)) continue;
    const canonical = url.protocol === "https:" && !url.port && main.test(path);
    return { kind: "login", site: canonical ? site : other };
  }
  for (const [h, p, site] of DOWNLOAD_PAGES) if (h.test(host) && p.test(path)) return { kind: "download", site };
  return null;
}

const ENTITIES                         = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

function decodeEntities(text        )         {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name        ) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function nasaModelLink(html        , base        )                                         {
  if (typeof html !== "string") return null;
  const resolve = (raw        )             => {
    try {
      const url = new URL(decodeEntities(raw.trim()), base);
      return url.protocol === "https:" && url.hostname === "assets.science.nasa.gov" ? url : null;
    } catch {
      return null;
    }
  };

  let fromViewer             = null;
  const viewers = /<model-viewer\b/gi;
  for (let n = 0; n < NASA_MAX_VIEWERS; n++) {
    const at = viewers.exec(html);
    if (!at) break;
    const tag = html.slice(at.index, at.index + NASA_TAG_CHARS);
    const close = tag.indexOf(">");
    const src = /\ssrc\s{0,16}=\s{0,16}["']([^"']{1,2048})["']/i.exec(close < 0 ? tag : tag.slice(0, close));
    if (src) {
      fromViewer = resolve(src[1]);
      break;
    }
  }
  if (fromViewer && MODEL_FILE_RE.test(fromViewer.pathname)) return { url: fromViewer.toString(), model: true };
  const links        = [];
  let seen = 0;
  for (const m of html.matchAll(/\bhref\s{0,16}=\s{0,16}["']([^"']{1,2048})["']/gi)) {
    if (++seen > NASA_MAX_LINKS) break;
    const url = resolve(m[1]);
    if (url) links.push(url);
  }
  const file = links.find((url) => MODEL_FILE_RE.test(url.pathname));
  if (file) return { url: file.toString(), model: true };
  const zip = links.find((url) => ZIP_FILE_RE.test(url.pathname));
  return zip ? { url: zip.toString(), model: false } : null;
}

const WEB_QUALITY = ["low", "medium", "high", "thumb", "ar"];

function smithsonianModelLink(answer         , id        )                {
  const rows = answer && typeof answer === "object" && Array.isArray((answer       ).rows) ? ((answer       ).rows             ) : [];
  const files                                                                                    = [];
  for (const row of rows) {
    const c = row && typeof row === "object" ? (row       ).content : null;
    if (!c || typeof c !== "object" || c.model_url !== `3d_package:${id}` || typeof c.uri !== "string") continue;
    const url = parseHttps(c.uri);
    if (!url || url.protocol !== "https:" || !(url.hostname === "si.edu" || url.hostname.endsWith(".si.edu"))) continue;
    const type = String(c.file_type || "").toLowerCase();
    files.push({
      usage: String(c.usage || ""),
      quality: String(c.quality || "").toLowerCase(),
      url,
      glb: type === "glb" || type.endsWith(" glb") || /\.glb$/i.test(url.pathname),
      draco: c.draco_compressed === true || /draco/i.test(type) || /draco/i.test(url.pathname),
    });
  }
  const plain = files.find((f) => f.usage === "Download3D" && f.glb && !f.draco);
  if (plain) return plain.url.toString();
  const rank = (q        ) => (WEB_QUALITY.includes(q) ? WEB_QUALITY.indexOf(q) : WEB_QUALITY.length);
  const web = files.filter((f) => f.usage === "Web3D" && f.glb).sort((a, b) => rank(a.quality) - rank(b.quality))[0];
  return web ? web.url.toString() : null;
}

const NO_MODEL = ()                    => ({ ok: false, code: "model_unreadable", detail: MODEL_PAGE_EMPTY });

async function resolvePicturePage(src        , opts                     )                                    {
  if (!opts || opts.httpEnabled !== true) return null;
  const page = picturePageOf(src);
  if (!page) return null;
  switch (page.kind) {
    case "github":
      return { ok: true, url: page.url, model: page.model, lfs: page.lfs };
    case "login":
      return { ok: false, code: "model_needs_login", detail: page.site };
    case "download":
      return { ok: false, code: "model_needs_download", detail: page.site };
    case "nasa": {
      const read = await fetchPictureText(page.url, opts, PAGE_ACCEPT);
      if (!read.ok) return read;
      const link = nasaModelLink(read.text, read.url);
      return link ? { ok: true, url: link.url, model: link.model } : NO_MODEL();
    }
    case "smithsonian": {
      const ask = `${SMITHSONIAN_FILE_SEARCH}?q=${encodeURIComponent(page.id)}&rows=100`;
      const cap = Math.min(SMITHSONIAN_ANSWER_MAX_BYTES, Number.isFinite(opts.maxBytes) && (opts.maxBytes          ) > 0 ? (opts.maxBytes          ) : Infinity);
      const read = await fetchPictureText(ask, { ...opts, maxBytes: cap }, JSON_ACCEPT);
      if (!read.ok) return read;
      let answer          = null;
      try {
        answer = JSON.parse(read.text);
      } catch {
        return NO_MODEL();
      }
      const url = smithsonianModelLink(answer, page.id);
      return url ? { ok: true, url, model: true } : NO_MODEL();
    }
    default:
      return null;
  }
}

module.exports = { SMITHSONIAN_FILE_SEARCH, SMITHSONIAN_ANSWER_MAX_BYTES, picturePageOf, nasaModelLink, smithsonianModelLink, resolvePicturePage };
