const FRAME_WRAP_HEAD = "// OcuClaw frame: the host drew this game's frame and keeps it round the game below. Edit the game inside; leave these wrapper lines as they are.";
const OPEN = "const __ocuclawGame = (function () {\n";
const CLOSE = "\n})();\n";
const FRAME_PICTURE_NAME = "ocuclawFrame";

const FRAME_SURFACE_PREFIX = "ocuclaw_frame_";

const isFrameWrapped = (source     ) => typeof source === "string" && source.startsWith(FRAME_WRAP_HEAD + "\n" + OPEN);

function unwrapProgramCardFrame(source        )         {
  if (!isFrameWrapped(source)) return source;
  const start = FRAME_WRAP_HEAD.length + 1 + OPEN.length;
  const end = source.lastIndexOf(CLOSE);
  return end >= start ? source.slice(start, end) : source;
}

const jsonLine = (v         ) => JSON.stringify(v).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
const tailLine = (tail        , name        ) => {
  const m = new RegExp(`^const ${name} = (.*);$`, "m").exec(tail);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
};
const isBox = (b     )                => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isInteger(v) && v >= 0);

function frameBriefKeptOf(value     )                        {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const layout = value.layout;
  if (!layout || typeof layout !== "object" || !isBox(layout.view) || !Array.isArray(layout.words)) return null;
  const game = value.game && typeof value.game === "object" ? value.game : {};

  const text = (v     , max        ) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max).trim() : "");
  const plan = Array.isArray(game.plan) ? game.plan.map((line     ) => text(line, 200)).filter(Boolean).slice(0, 5) : [];
  const request = text(game.request, 300);
  const style = text(value.style, FRAME_STYLE_MAX);
  return { layout, game: { title: text(game.title, 80), ...(plan.length ? { plan } : {}), ...(request ? { request } : {}) }, ...(style ? { style } : {}) };
}

const FRAME_STYLE_MAX = 120;
function normalizeFrameStyle(style     )         {
  return typeof style === "string" ? style.replace(/\s+/g, " ").trim().slice(0, FRAME_STYLE_MAX).trim() : "";
}

function frameWrapOf(source     )                   {
  if (!isFrameWrapped(source)) return null;
  const tail = source.slice(source.lastIndexOf(CLOSE) + CLOSE.length);
  const art = tailLine(tail, "__ocuclawFrameArt");
  const place = tailLine(tail, "__ocuclawFramePlace");
  return {
    art: Array.isArray(art) ? art.filter(isBox) : [],
    place: place && typeof place === "object" && typeof place.viewId === "string" ? place               : null,
    brief: frameBriefKeptOf(tailLine(tail, "__ocuclawFrameBrief")),

    png: new RegExp(`${FRAME_PICTURE_NAME}: \\{ src: "data:image/png;base64,([A-Za-z0-9+/]+={0,2})"`).exec(tail)?.[1] ?? null,
  };
}

const PLACE_SOURCE = "const __ocuclawPlace = (scene, p) => {\n"
  + "  if (!p) return scene;\n"
  + "  const raster = scene.raster.map((s) => {\n"
  + "    if (!s || s.back || s.id !== p.viewId || !s.rect) return s;\n"
  + "    const x = Math.max(0, Math.min(576 - s.rect.w, s.rect.x + p.dx)), y = Math.max(0, Math.min(261 - s.rect.h, s.rect.y + p.dy));\n"
  + "    return Object.assign({}, s, { rect: Object.assign({}, s.rect, { x, y }),\n"
  + "      nodes: [{ type: \"transform\", translate: { x: x - s.rect.x, y: y - s.rect.y }, children: s.nodes || [] }] });\n"
  + "  });\n"
  + "  const native = Array.isArray(scene.native) ? scene.native.map((n) => {\n"
  + "    if (!n || !n.rect || !Object.prototype.hasOwnProperty.call(p.words, n.id)) return n;\n"
  + "    const at = p.words[n.id], narrowed = at.length > 2 && at[2] < n.rect.w;\n"
  + "    return Object.assign({}, n, { rect: Object.assign({}, n.rect, { x: at[0], y: at[1] }, narrowed ? { w: at[2] } : {}) }, narrowed ? { overflow: \"ellipsis\" } : {});\n"
  + "  }) : scene.native;\n"
  + "  return Object.assign({}, scene, { raster }, native ? { native } : {});\n"
  + "};\n";

const PLAY_PAGE_LINE = "    if (!scene || scene.input !== \"direct\" || !Array.isArray(scene.raster)) return scene;\n";

const BROWSE_PAGE_LINE = "    if (!scene || !Array.isArray(scene.raster)) return scene;\n";

const BROWSE_PLACE_LINE = "    if (Array.isArray(scene.native) && scene.native.some((n) => !n || n.viewport !== undefined"
  + " || !Object.prototype.hasOwnProperty.call(__ocuclawFramePlace.words, n.id))) return scene;\n";

const FITS_MARK = "    { const __v = scene.raster.find(";

function frameFitsLine(brief                                   )                {
  const view = brief?.layout?.view, id = brief?.layout?.viewId;
  if (!isBox(view) || typeof id !== "string" || !id) return null;
  return `${FITS_MARK}(r) => r && !r.back && r.id === ${JSON.stringify(id)} && r.rect);`
    + ` if (!__v || __v.rect.w !== ${view[2]} || __v.rect.h !== ${view[3]}) return scene; }\n`;
}

function frameFitsUpgrade(source     )                                           {
  if (!isFrameWrapped(source) || source.includes(FITS_MARK)) return null;
  const line = frameFitsLine(frameWrapOf(source)?.brief);
  const at = source.lastIndexOf(CLOSE);
  if (!line || source.indexOf(PLAY_PAGE_LINE, at) < 0 || source.indexOf(PLAY_PAGE_LINE) !== source.indexOf(PLAY_PAGE_LINE, at)) return null;
  return { find: PLAY_PAGE_LINE, replace: PLAY_PAGE_LINE + line };
}

const FRAME_VIEW_RIM_GRAY = 12;

function rimLine(viewId        ) {
  return `    const surfaces = placed.raster.map((r) => r && !r.back && r.id === ${jsonLine(viewId)} && r.rect && r.rect.w > 4 && r.rect.h > 4`
    + " ? Object.assign({}, r, { nodes: (r.nodes || []).concat([{ type: \"rect\", rect: { x: r.rect.x + 1, y: r.rect.y + 1, w: r.rect.w - 2, h: r.rect.h - 2 },"
    + ` paint: { stroke: ${FRAME_VIEW_RIM_GRAY}, width: 2 } }]) }) : r);\n`;
}

function wrapProgramCardFrame(source        , frame            )         {
  const game = unwrapProgramCardFrame(source);
  const src = "data:image/png;base64," + (globalThis       ).Buffer.from(frame.png).toString("base64");
  const art = jsonLine(frame.art.map((a) => a.map((v) => Math.trunc(v))));
  const place = frame.place ? jsonLine({ viewId: frame.place.viewId, dx: Math.trunc(frame.place.dx), dy: Math.trunc(frame.place.dy),
    words: Object.fromEntries(Object.entries(frame.place.words).map(([id, at]) => [id, at.map((v) => Math.trunc(v))])) }) : null;

  const kept = frame.brief ? frameBriefKeptOf(frame.brief) : null;

  const fits = frameFitsLine(kept);
  const browse = (kept?.layout                           )?.browse === true && !!fits;
  const viewId = frame.place?.viewId ?? (kept?.layout                           )?.viewId;
  const rimmed = typeof viewId === "string" && viewId ? viewId : null;
  return FRAME_WRAP_HEAD + "\n" + OPEN + game + CLOSE
    + `const __ocuclawFrameArt = ${art};\n`
    + (place ? PLACE_SOURCE + `const __ocuclawFramePlace = ${place};\n` : "")
    + (kept ? `const __ocuclawFrameBrief = ${jsonLine(kept)};\n` : "")
    + "return Object.assign({}, __ocuclawGame, {\n"
    + `  pictures: Object.assign({}, __ocuclawGame.pictures, { ${FRAME_PICTURE_NAME}: { src: "${src}", exact: true } }),\n`
    + "  view(s, ctx) {\n"
    + "    const scene = __ocuclawGame.view.call(this, s, ctx);\n"
    + (browse ? BROWSE_PAGE_LINE : PLAY_PAGE_LINE)
    + (fits ?? "")
    + (browse && place ? BROWSE_PLACE_LINE : "")
    + (place ? "    const placed = __ocuclawPlace(scene, __ocuclawFramePlace);\n" : "    const placed = scene;\n")
    + (rimmed ? rimLine(rimmed) : "    const surfaces = placed.raster;\n")
    + `    const frame = __ocuclawFrameArt.map(([x, y, w, h], i) => ({ id: "${FRAME_SURFACE_PREFIX}" + i, rect: { x, y, w, h }, back: true,\n`
    + `      nodes: [ui.image("${FRAME_PICTURE_NAME}", x, y, w, h, "pixel", { x, y, w, h })] }));\n`
    + "    return Object.assign({}, placed, { raster: frame.concat(surfaces) });\n"
    + "  },\n"
    + "});\n";
}

module.exports = { FRAME_WRAP_HEAD, FRAME_PICTURE_NAME, FRAME_SURFACE_PREFIX, isFrameWrapped, unwrapProgramCardFrame, frameBriefKeptOf, FRAME_STYLE_MAX, normalizeFrameStyle, frameWrapOf, frameFitsUpgrade, FRAME_VIEW_RIM_GRAY, wrapProgramCardFrame };
