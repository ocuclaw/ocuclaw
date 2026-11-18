const { LIVEUI_REGISTRY } = require("../liveui-registry/index.cjs");

const { compileLiveUiFormula, liveUiNameProblem } = require("./formula.cjs");

const { createLiveUiFormulaSet } = require("./formula-set.cjs");

const { LIVEUI_PICTURE_DATA_CALL_MAX_CHARS: COMPOSE_CALL_DATA_MAX_CHARS } = require("../glasses-ui-compose-tool.cjs");

const REG = LIVEUI_REGISTRY;
const FRAMES                                   = new Map(REG.frames.map((f) => [f.name, f]));
const COMPONENTS                                       = new Map(REG.components.map((c) => [c.name, c]));
const KIND_PROPS = new Map(REG.records.kinds.map((k) => [k.kind, k.props]));
const FRAME_TITLE_PROP = (KIND_PROPS.get("frame") ?? []).find((p) => p.name === "title");
const LET_NAME_PROP = (KIND_PROPS.get("let") ?? []).find((p) => p.name === "let");
const COMPONENT_RECORD_PROPS                                  = new Map(
  (KIND_PROPS.get("component") ?? []).map((p) => [p.name, p]),
);
const DRIVER_ATTRS                                  = new Map(REG.records.driver.map((p) => [p.name, p]));

const STRUCTURAL_ATTRS = new Set(["id", "c", "in", "remove"]);

const SURFACE_MAX_CHARS = REG.budgets.recordChars;

const STATE_SEED_PROPS = new Set(["init"]);
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const LET_ON_PROP = (KIND_PROPS.get("let") ?? []).find((p) => p.name === "on");

const LIVEUI_UNDO_ACTION = "undo";

const LIVEUI_WRITE_SINCE = Math.max(...REG.behaviours.filter((b) => b.name === "keep" || b.name === "append").map((b) => b.since));

function splitOutsideQuotes(text        , sep        )           {
  const out           = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    else if (ch === sep && !quoted) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim());
}

function parseKeepOn(value        , repairs          )                                            {
  const out                                            = [];
  for (const item of splitOutsideQuotes(value, "|")) {
    if (!item) continue;
    const colon = item.indexOf(":");
    const action = colon > 0 ? item.slice(0, colon).trim() : "";
    const source = colon > 0 ? item.slice(colon + 1).trim() : "";
    if (!action || !source || liveUiNameProblem(action) !== null || out.some((w) => w.action === action)) {
      repairs.push("items_trimmed");
      continue;
    }
    out.push({ action, source });
  }
  const max = LET_ON_PROP?.maxItems;
  if (max !== undefined && out.length > max) {
    repairs.push("items_trimmed");
    out.length = max;
  }
  return out;
}

function cloneSurfaceModel(model                    )                     {
  return {
    frame: model.frame,
    title: model.title,
    entries: model.entries.map((e) => ({ ...e, attrs: { ...e.attrs }, rows: [...e.rows] })),
  };
}

const isRemove = (attrs                        )          =>
  Object.hasOwn(attrs, "remove") && (attrs.remove === "" || attrs.remove.trim().toLowerCase() === "true");

function codePoints(text        )         {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function cutChars(text        , max        )         {
  return Array.from(text).slice(0, max).join("");
}

const SERIES_CELL_RE = /^\s*-?\d+(?:\.\d+)?(?:[\s,]+-?\d+(?:\.\d+)?)+\s*$/;

function cutCell(cell        , max        )         {
  if (!SERIES_CELL_RE.test(cell)) return cutChars(cell, max);
  let out = "";
  for (const n of cell.trim().split(/[\s,]+/)) {
    const next = out ? `${out} ${n}` : n;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

function inferFrame(region                    , decidedFrame                           )                {
  if (decidedFrame && FRAMES.has(decidedFrame)) return decidedFrame;
  if (!region) return null;
  const withRegion = REG.frames.filter((f) => f.regions.some((r) => r.name === region));
  return withRegion.length === 1 ? withRegion[0].name : null;
}

function oneLineFields(component                             )           {
  if (!component || !component.body) return [];
  if (component.body.form === "pairs") return component.props.map((p) => p.name);
  return [component.body.prop];
}

function foldUiRecords(records                     , options                    = {})                   {
  const final = options.final === true;
  const base = options.base ?? null;
  const notes                     = [];
  const touched           = [];
  const removes           = [];
  let mode                 = "none";
  let model                            = null;
  let frameRepaired = false;
  let contentSeen = false;
  let untitled = false;
  const drop = (key        , name        , code        , detail        ) =>
    notes.push({ key, name, code, detail, kind: "drop" });

  const firstComponentRegion = ()                     => {
    for (const rec of records) {
      if (rec.kind === "component" && rec.attrs && !rec.dropped && rec.attrs.in) return rec.attrs.in;
    }
    return undefined;
  };

  records.forEach((rec, index) => {
    const anonymous = `record:${index}`;
    if (rec.dropped) {
      const name = rec.attrs?.id ?? rec.attrs?.let ?? (rec.kind === "frame" ? "frame" : anonymous);
      drop(keyOf(rec) ?? anonymous, name, rec.dropped, `the reply's records pass ${REG.budgets.recordChars} characters`);
      return;
    }
    if (rec.broken || !rec.attrs) {
      drop(anonymous, anonymous, "parse", rec.broken ? "the open tag is not closed" : "the record does not parse");
      return;
    }
    if (!rec.kind) {
      drop(anonymous, anonymous, "parse", "a record names exactly one of frame, let or id");
      return;
    }
    const attrs = rec.attrs;
    if (mode === "none") {
      const named = options.namedFrame;
      if (rec.kind === "frame") {
        mode = "new";
      } else if (named && FRAMES.has(named.frame)) {

        mode = "new";
        model = { frame: named.frame, title: named.title, entries: [] };
        untitled = !named.title;
        notes.push({ key: "frame", name: "frame", code: "frame_repaired", detail: `the reply's ${named.frame} frame`, kind: "repair" });
      } else if (base) {
        mode = "patch";
        model = cloneSurfaceModel(base);
      } else {
        const frame = inferFrame(firstComponentRegion(), options.decidedFrame);
        if (frame) {
          mode = "new";
          model = { frame, title: "", entries: [] };
          frameRepaired = true;
          notes.push({ key: "frame", name: "frame", code: "frame_repaired", detail: `placed on ${frame}`, kind: "repair" });
        } else {
          mode = "text";
        }
      }
    }
    if (mode === "text") {
      const name = attrs.id ?? attrs.let ?? "frame";
      if (rec.kind === "component" && (!attrs.c || isRemove(attrs))) {

        drop(keyOf(rec) ?? anonymous, name, "unknown_id", isRemove(attrs) ? `remove names unknown id ${name}` : `unknown id ${name}`);
        return;
      }
      drop(keyOf(rec) ?? anonymous, name, "no_frame", "no frame record, and no one frame has its Region");
      return;
    }

    if (rec.kind === "frame") {
      if (mode === "patch" || contentSeen) {
        drop("frame", "frame", "frame_after_content", "a frame record after content starts no second surface");
        return;
      }
      const frameName = attrs.frame;
      if (!FRAMES.has(frameName)) {
        drop("frame", "frame", "bad_value", `unknown frame ${frameName}`);
        return;
      }
      const rawTitle = (attrs.title ?? "").replace(/\s+/g, " ").trim();
      const max = FRAME_TITLE_PROP?.maxChars ?? 64;
      const title = codePoints(rawTitle) > max ? cutChars(rawTitle, max) : rawTitle;
      if (title !== rawTitle) notes.push({ key: "frame", name: "frame", code: "text_truncated", detail: "title cut", kind: "repair" });

      untitled = !title;
      model = { frame: frameName, title, entries: [] };
      frameRepaired = false;
      if (!touched.includes("frame")) touched.push("frame");
      return;
    }

    contentSeen = true;
    if (!model) {

      const frame = inferFrame(attrs.in ?? firstComponentRegion(), options.decidedFrame);
      if (!frame) {
        drop(keyOf(rec) ?? anonymous, attrs.id ?? attrs.let ?? anonymous, "no_frame", "no valid frame record");
        return;
      }
      model = { frame, title: "", entries: [] };
      frameRepaired = true;
      notes.push({ key: "frame", name: "frame", code: "frame_repaired", detail: `placed on ${frame}`, kind: "repair" });
    }
    const surface                     = model;
    const name = rec.kind === "let" ? attrs.let : attrs.id;
    const key = rec.kind === "let" ? `let:${name}` : `id:${name}`;
    const existingIndex = surface.entries.findIndex((e) => e.key === key);
    const existing = existingIndex >= 0 ? surface.entries[existingIndex] : null;

    if (isRemove(attrs)) {
      if (!existing) {
        drop(key, name, "unknown_id", `remove names unknown ${rec.kind === "let" ? "let" : "id"} ${name}`);
        return;
      }
      if (!removes.includes(key)) removes.push(key);
      if (final) surface.entries.splice(existingIndex, 1);
      return;
    }

    if (existing) {

      if (!rec.closed && !final) return;
      const sameComponent = rec.kind === "let" || !attrs.c || attrs.c === existing.attrs.c;
      let merged                  ;
      if (!sameComponent) {

        merged = entryFrom(rec, key, name);
        if (!Object.hasOwn(attrs, "in") && typeof existing.attrs.in === "string") {
          merged.attrs = { in: existing.attrs.in, ...merged.attrs };
        }
      } else {
        const component = COMPONENTS.get(attrs.c ?? existing.attrs.c);
        const oneLine = oneLineFields(component);
        const nextAttrs = { ...existing.attrs };
        let body = existing.body;
        let rows = existing.rows;
        if (rec.body !== null) {
          for (const field of oneLine) delete nextAttrs[field];
          body = rec.body;
          rows = [...rec.rows];
        } else if (oneLine.some((field) => Object.hasOwn(attrs, field))) {
          body = null;
          rows = [];
        }
        Object.assign(nextAttrs, attrs);
        merged = {
          ...existing,
          attrs: nextAttrs,
          body,
          rows,
          closed: rec.closed || final,
          chars: rec.chars,
        };
      }
      surface.entries[existingIndex] = merged;
      if (!touched.includes(key)) touched.push(key);
      return;
    }

    if (rec.kind === "component" && !attrs.c) {
      drop(key, name, "unknown_id", `unknown id ${name}`);
      return;
    }
    const entry = entryFrom(rec, key, name);
    if (final) entry.closed = true;
    surface.entries.push(entry);
    if (!touched.includes(key)) touched.push(key);
  });

  const surface = model                             ;
  if ((untitled           ) && surface && !surface.title) {
    if (final && !surface.entries.some((e) => e.kind === "component")) {

      drop("frame", "frame", "missing_field", "a frame record needs a title");
      model = null;
    } else {
      const found = titleFromWords(surface.entries);
      if (found) surface.title = found.title;
      notes.push({
        key: "frame",
        name: "frame",
        code: "frame_repaired",
        detail: found ? `title from ${found.from}` : "no title, and no words to take one from",
        kind: "repair",
      });
    }
  }
  if ((mode                  ) === "new" && !model) mode = "text";
  return { mode, model, frameRepaired, touched, removes, notes };
}

function titleFromWords(entries                             )                                         {
  const max = FRAME_TITLE_PROP?.maxChars ?? 64;
  const words = (value                    )                => {
    const line = (value ?? "").replace(/\s+/g, " ").trim();
    if (!line || line.startsWith("=")) return null;
    const cut = codePoints(line) > max ? cutChars(line, max).trimEnd() : line;

    return cut.replace(/(?<!\.)\.$/, "") || null;
  };
  for (const c of ["image", "text"]) {
    for (const e of entries) {
      if (e.kind !== "component" || e.attrs.c !== c) continue;
      const found = c === "image" ? words(e.attrs.alt) : words(e.body !== null ? e.rows[0] : e.attrs.text);
      if (found) return { title: found, from: e.name };
    }
  }
  return null;
}

function keyOf(rec          )                {
  if (!rec.attrs || !rec.kind) return null;
  if (rec.kind === "frame") return "frame";
  if (rec.kind === "let") return `let:${rec.attrs.let}`;
  return `id:${rec.attrs.id}`;
}

function entryFrom(rec          , key        , name        )                   {
  return {
    key,
    kind: rec.kind === "let" ? "let" : "component",
    name,
    attrs: { ...(rec.attrs ?? {}) },
    body: rec.body,
    rows: [...rec.rows],
    closed: rec.closed,
    chars: rec.chars,
  };
}

const LIVEUI_PICTURES_PER_REVISION = 20;

const LIVEUI_PICTURE_DATA_MAX_CHARS = 73_728;

const LIVEUI_PICTURE_DATA_CALL_MAX_CHARS = COMPOSE_CALL_DATA_MAX_CHARS;

const PICTURE_CELL_MAX_CHARS = 2048;

function isFetchedPictureSource(value        )          {
  return /^https?:\/\//i.test(value) || /^file:\/\//i.test(value) || value.startsWith("/") || value.startsWith("~/");
}

function isDataPictureSource(value        )          {
  return /^data:/i.test(value);
}

class RecordFailure extends Error {
  code        ;
  constructor(code        , detail        ) {
    super(detail);
    this.code = code;
  }
}

const fail = (code        , detail        )        => {
  throw new RecordFailure(code, detail);
};

function driverRegion(frame             )                           {
  return frame.regions.find((r) => r.role === "driver") ?? null;
}

const OPERATOR_SINCE                              = new Map(REG.operators.map((o) => [o.name, o.since]));

function specVocab(
  frame             ,
  regions                                       ,
  derive                                   ,
  keep                                  = {},
)         {
  let vocab = frame.since;

  const writes = Object.keys(keep).length > 0 || Object.values(regions).some((comps) => comps.some((c) => typeof c.on === "string"));
  if (writes) vocab = Math.max(vocab, LIVEUI_WRITE_SINCE);
  const visit = (value         , depth        )       => {
    if (depth > 64 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) visit(v, depth + 1);
      return;
    }
    const keys = Object.keys(value);
    const since = keys.length === 1 ? OPERATOR_SINCE.get(keys[0]) : undefined;
    if (since !== undefined) vocab = Math.max(vocab, since);
    for (const v of Object.values(value)) visit(v, depth + 1);
  };
  for (const comps of Object.values(regions)) {
    for (const comp of comps) {
      vocab = Math.max(vocab, COMPONENTS.get(comp.c)?.since ?? 1);
      visit(comp, 0);
    }
  }
  visit(derive, 0);
  for (const kept of Object.values(keep)) {
    visit(kept.be, 0);
    for (const tree of Object.values(kept.on)) visit(tree, 0);
  }
  return vocab;
}

function foldLiveUiLocalWrites(spec                   )                    {
  const keep = spec.keep ?? {};
  const kept = new Set(Object.keys(keep));
  const growing = Object.values(spec.regions).some((comps) => comps.some((c) => typeof c.on === "string" || Array.isArray(c.row)));
  if (kept.size === 0 && !growing) return spec;
  const reread = (value         , depth = 0)          => {
    if (depth > 64 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => reread(v, depth + 1));
    const o = value                           ;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "state" && typeof o.state === "string" && kept.has(o.state.slice(1))) {
      return { ref: o.state.slice(1) };
    }
    const out                          = {};
    for (const [k, v] of Object.entries(o)) out[k] = reread(v, depth + 1);
    return out;
  };
  const derive                                    = {};
  for (const [name, tree] of Object.entries(spec.derive)) derive[name] = reread(tree)                     ;
  for (const [name, value] of Object.entries(keep)) derive[name] = reread(value.be)                     ;
  const regions                                        = {};
  for (const [region, comps] of Object.entries(spec.regions)) {
    regions[region] = comps.map((comp) => {
      const out = reread(comp)                       ;
      delete out.on;
      delete out.row;
      if (Array.isArray(out.actions)) {
        out.actions = (out.actions                                  ).map(({ local: _local, ...rest }) => rest);
      }
      return out;
    });
  }
  const { keep: _keep, ...rest } = spec;
  return { ...rest, derive, regions };
}

function markLocalActions(
  regions                                       ,
  keep                                 ,
  final         ,
  notes                    ,
)       {
  const comps = Object.values(regions).flat();
  const actionIds = new Set        ();
  for (const comp of comps) {
    for (const item of (comp.actions                                     ) ?? []) actionIds.add(item.id);
  }
  if (final) {
    for (const [name, kept] of Object.entries(keep)) {
      const gone = Object.keys(kept.on).filter((id) => !actionIds.has(id));
      for (const id of gone) delete kept.on[id];
      if (gone.length > 0) notes.push({ key: `let:${name}`, name, code: "items_trimmed", detail: `on names no action ${gone.join(", ")}`, kind: "repair" });
    }
    for (const comp of comps) {
      if (typeof comp.on !== "string" || actionIds.has(comp.on)) continue;
      notes.push({ key: `id:${comp.id}`, name: comp.id, code: "field_dropped", detail: `on names no action ${comp.on}`, kind: "repair" });
      delete comp.on;
      delete comp.row;
    }
  }
  const writes = new Set        ();
  for (const kept of Object.values(keep)) for (const id of Object.keys(kept.on)) writes.add(id);
  for (const comp of comps) if (typeof comp.on === "string") writes.add(comp.on);
  if (writes.size === 0) return;
  for (const comp of comps) {
    const actions = comp.actions                                                                    ;
    if (!actions) continue;
    for (const item of actions) {
      if (writes.has(item.id)) item.local = "write";
      else if (item.id === LIVEUI_UNDO_ACTION) item.local = "undo";
    }
  }
}

const isDriving = (component                 )          =>
  component.drives.role === "rows" || component.drives.role === "pages";

function fits(component                 , region                   )          {
  return component.fits.some((f) => f.sizeClass === region.sizeClass);
}

function slug(label        )         {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseDurationMs(text        )                {
  const m = /^\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?\s*$/.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 1000;
}

function cellValue(text        )                  {
  if (!NUMBER_RE.test(text)) return text;
  const n = Number(text);
  const written = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
  return String(n) === written ? n : text;
}

function literalText(value        , prop            , repairs          )         {
  if (prop.maxChars !== undefined && codePoints(value) > prop.maxChars) {
    if (prop.overflow === "reject") fail("bad_value", `${prop.name} holds more than ${prop.maxChars} characters`);
    repairs.push("text_truncated");
    return cutChars(value, prop.maxChars);
  }
  return value;
}

const CLOCK_ITEM_RE = /^\d{1,2}:\d{2}(?!\d)/;

function parsePairs(
  value        ,
  prop            ,
  repairs          ,
)                                       {
  const out                                       = [];
  const seen = new Set        ();
  const items = value.split("|").map((s) => s.trim()).filter(Boolean);
  for (const item of items) {
    const colon = CLOCK_ITEM_RE.test(item) ? -1 : item.indexOf(":");
    const id = colon > 0 ? item.slice(0, colon).trim() : slug(item);
    let label = (colon > 0 ? item.slice(colon + 1) : item).trim();
    if (!id || !label) {
      repairs.push("items_trimmed");
      continue;
    }
    if (prop.values && !prop.values.includes(id)) {
      repairs.push("items_trimmed");
      continue;
    }
    if (prop.labelMaxChars !== undefined && codePoints(label) > prop.labelMaxChars) {
      repairs.push("text_truncated");
      label = cutChars(label, prop.labelMaxChars);
    }
    const dedupe = prop.values ? `${id}:${label}` : id;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ id, label });
  }
  if (prop.maxItems !== undefined && out.length > prop.maxItems) {
    repairs.push("items_trimmed");
    out.length = prop.maxItems;
  }
  return out;
}

function pictureField(src        , opts                )                         {
  const value = src.trim();
  if (isDataPictureSource(value)) {

    if (!opts.pictureBytes) fail("picture_bytes_inline", "picture bytes go only through compose_glasses_ui");
    const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
    if (!match) fail("bad_value", "src is not a data:image/…;base64, picture");
    if (match [1].replace(/\s+/g, "").length > LIVEUI_PICTURE_DATA_MAX_CHARS) {
      fail("picture_too_large", `picture bytes over ${LIVEUI_PICTURE_DATA_MAX_CHARS} base64 characters`);
    }
    return { pic: opts.picId(value) };
  }
  if (isFetchedPictureSource(value)) return { pic: opts.picId(value) };
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {

    const bytes = opts.assetSource(value);
    return bytes ? { pic: opts.picId(bytes) } : { asset: value };
  }
  return fail("bad_value", `src ${value} is not a web address, a file path or an asset name`);
}

function shapeEntry(entry                  , frame             , opts                                     )         {
  const repairs           = [];
  const rowNotes                     = [];
  const attrs = entry.attrs;
  const closed = entry.closed || opts.final;
  if (entry.kind === "let") {
    const problem = liveUiNameProblem(entry.name);
    if (problem) fail("bad_value", problem);
    if (LET_NAME_PROP?.maxChars !== undefined && codePoints(entry.name) > LET_NAME_PROP.maxChars) {
      fail("bad_value", `let name over ${LET_NAME_PROP.maxChars} characters`);
    }
    if (!Object.hasOwn(attrs, "be") || !attrs.be.trim()) fail("missing_field", `let ${entry.name} has no be`);
    let keepOn                                                       ;
    for (const k of Object.keys(attrs)) {
      if (k === "on") {

        keepOn = parseKeepOn(attrs.on, repairs);
        if (keepOn.length === 0) {
          keepOn = undefined;
          repairs.push("field_dropped");
        }
      } else if (k !== "let" && k !== "be" && k !== "remove") repairs.push("field_dropped");
    }
    return { entry, component: null, region: "", props: {}, formulas: [], repairs, rowNotes, letSource: attrs.be, keepOn };
  }

  if (liveUiNameProblem(entry.name) !== null && entry.name.includes("-")) {
    const repaired = entry.name.replace(/-/g, "_");
    if (liveUiNameProblem(repaired) === null) {
      entry = { ...entry, name: repaired };
      repairs.push("id_repaired");
    }
  }
  const problem = liveUiNameProblem(entry.name);
  if (problem) fail("bad_value", problem);
  const idMax = COMPONENT_RECORD_PROPS.get("id")?.maxChars;
  if (idMax !== undefined && codePoints(entry.name) > idMax) fail("bad_value", `id over ${idMax} characters`);
  const component = COMPONENTS.get(attrs.c);
  if (!component) fail("unknown_component", `unknown component ${attrs.c}`);
  const comp = component                   ;
  if (!attrs.in) fail("missing_field", `${entry.name} names no Region`);
  const region = frame.regions.find((r) => r.name === attrs.in);
  if (!region) fail("unknown_region", `no Region ${attrs.in} in ${frame.name}`);

  const props                          = {};
  const formulas                 = [];
  const propsByName = new Map(comp.props.map((p) => [p.name, p]));

  const grows = comp.behaviours.some((b) => b.name === "append") && Boolean(attrs.on?.trim()) && Boolean(attrs.row?.trim());

  for (const [k, v] of Object.entries(attrs)) {
    if (STRUCTURAL_ATTRS.has(k)) continue;
    const prop = propsByName.get(k) ?? COMPONENT_RECORD_PROPS.get(k) ?? DRIVER_ATTRS.get(k);
    if (!prop) {
      repairs.push("field_dropped");
      continue;
    }
    takeProp(prop, v, props, formulas, repairs, opts);
  }

  const body = comp.body;
  if (body && entry.body !== null) {
    if (body.form === "rows") {
      if (Object.hasOwn(props, "rows") || formulas.some((f) => f.field === "rows")) {
        repairs.push("field_dropped");
        delete props.rows;
        for (let i = formulas.length - 1; i >= 0; i -= 1) if (formulas[i].field === "rows") formulas.splice(i, 1);
      }
      props.$rows = entry.rows;
    } else if (body.form === "pairs") {
      props.$pairs = entry.rows;
    } else if (body.form === "text") {
      const text = entry.body.trim();
      for (let i = formulas.length - 1; i >= 0; i -= 1) if (formulas[i].field === body.prop) formulas.splice(i, 1);
      delete props[body.prop];
      if (text.startsWith("=") && !text.startsWith("==")) {
        formulas.push({ field: body.prop, source: text, expect: "text", assign: (t) => { props[body.prop] = t; } });
      } else {
        const prop = propsByName.get(body.prop);
        props[body.prop] = prop ? literalText(text, prop, repairs) : text;
      }
    } else if (body.form === "pages") {
      props.$pages = entry.body;
    } else if (body.form === "slots") {
      if (closed) props.$slots = entry.body;
    }
  }
  if (comp.rows && !Array.isArray(props.cols)) {
    const colsDefault = comp.props.find((p) => p.name === "cols")?.default;
    props.cols = String(colsDefault ?? "label").split(",").map((s) => s.trim());
  }

  for (const prop of comp.props) {
    if (!prop.required) continue;
    const present =
      Object.hasOwn(attrs, prop.name) ||
      (body !== null && body.prop === prop.name && entry.body !== null);
    if (present) continue;
    if (prop.default !== undefined && prop.default !== null) {
      props[prop.name] = prop.default;
      repairs.push(prop.name === "alt" ? "alt_repaired" : "field_dropped");
      continue;
    }
    fail("missing_field", `${comp.name} ${entry.name} needs ${prop.name}`);
  }
  if (body && closed && entry.body === null && body.minItems && body.minItems > 0 && !grows) {
    const fromAttr = Object.hasOwn(props, body.prop) || formulas.some((f) => f.field === body.prop);
    if (!fromAttr && body.form !== "pairs") fail("missing_field", `${comp.name} ${entry.name} has no ${body.prop}`);
    if (body.form === "pairs" && !Object.hasOwn(props, "value") && !formulas.some((f) => f.field === "value")) {
      fail("missing_field", `${comp.name} ${entry.name} has no lines and no value`);
    }
  }
  if (body && body.form === "text" && closed && props[body.prop] === "" && !formulas.some((f) => f.field === body.prop)) {
    fail("missing_field", `${comp.name} ${entry.name} has no ${body.prop}`);
  }

  if (props.$rows !== undefined) {
    shapeRows(comp, entry, props, repairs, closed, grows);
  } else if (grows && !formulas.some((f) => f.field === "rows")) {
    props.$literalRows = [];
  }
  shapeGrowth(entry, props, formulas, repairs, grows);
  if (props.$pairs !== undefined) {
    shapePairs(comp, entry, props, formulas, repairs, rowNotes, closed);
  }
  if (props.$pages !== undefined) {
    shapePages(comp, props, repairs, closed);
  }
  if (props.$slots !== undefined) {
    shapeSlots(comp, props, formulas, repairs);
  } else if (body && body.form === "slots" && !closed) {
    props.slots = [];
  }

  for (const prop of comp.props) {
    if (prop.itemsName !== "cols" || !Array.isArray(props[prop.name])) continue;
    const cols = (props.cols                        ) ?? [];
    const items = props[prop.name]            ;
    const kept = items.filter((item) => cols.includes(item.replace(/^-/, "")));
    if (kept.length === items.length) continue;
    repairs.push("field_dropped");
    if (kept.length > 0) props[prop.name] = kept;
    else delete props[prop.name];
  }

  if (comp.name === "stepper") {
    const options = props.options                                                    ;
    if (options && options.length > 0) {

      for (const bound of ["min", "max", "by"]) {
        if (!Object.hasOwn(props, bound) && !formulas.some((f) => f.field === bound)) continue;
        delete props[bound];
        for (let i = formulas.length - 1; i >= 0; i -= 1) if (formulas[i].field === bound) formulas.splice(i, 1);
        repairs.push("field_dropped");
      }
      if (props.init !== undefined && !options.some((o) => o.id === props.init)) {

        const named = options.find((o) => o.label === String(props.init).trim());
        if (!named) fail("bad_value", `init ${String(props.init)} names no option`);
        props.init = named .id;
        repairs.push("id_repaired");
      }
    } else {
      for (const bound of ["min", "max"]) {
        if (!Object.hasOwn(props, bound) && !formulas.some((f) => f.field === bound)) {
          fail("missing_field", `stepper ${entry.name} needs ${bound} or options`);
        }
      }
      if (props.init !== undefined) {
        if (!NUMBER_RE.test(String(props.init))) fail("bad_value", `init ${String(props.init)} is not a number`);
        props.init = Number(props.init);
      }
    }
  }
  return { entry, component: comp, region: region .name, props, formulas, repairs, rowNotes };
}

function takeProp(
  prop            ,
  raw        ,
  props                         ,
  formulas                ,
  repairs          ,
  opts                ,
)       {
  const name = prop.name;
  const value = raw;
  const formulaField = (source        , bindingOnly = false) =>
    formulas.push({
      field: name,
      source,
      expect: prop.resultType ?? "any",
      assign: (t) => { props[name] = t; },
      bindingOnly,
    });
  if (prop.takes === "formula") {
    formulaField(value);
    return;
  }
  if (prop.takes === "text_or_formula") {
    const trimmed = value.trim();
    const isFormula = trimmed.startsWith("=") && !trimmed.startsWith("==");
    if (name === "src") {
      if (isFormula) {
        formulas.push({
          field: "pic",
          source: trimmed,
          expect: "text",
          assign: (t) => { props.pic = t; },
          bindingOnly: true,
        });
      } else if (isDataPictureSource(trimmed)) {

        Object.assign(props, pictureField(trimmed, opts));
      } else {
        Object.assign(props, pictureField(literalText(value, prop, repairs), opts));
      }
      return;
    }
    if (isFormula) {
      formulaField(trimmed, name === "alt");
      return;
    }
    props[name] = literalText(value, prop, repairs);
    return;
  }
  switch (prop.type) {
    case "text":
      props[name] = literalText(value, prop, repairs);
      return;
    case "number": {
      if (!NUMBER_RE.test(value.trim())) fail("bad_value", `${name} ${value} is not a number`);
      const n = Number(value.trim());
      if ((prop.min !== undefined && n < prop.min) || (prop.max !== undefined && n > prop.max)) {
        fail("bad_value", `${name} ${n} is out of range`);
      }
      props[name] = n;
      return;
    }
    case "bool": {
      const v = value.trim().toLowerCase();
      if (v === "" || v === "true") props[name] = true;
      else if (v === "false") props[name] = false;
      else fail("bad_value", `${name} ${value} is not true or false`);
      return;
    }
    case "enum":
      if (!prop.values || !prop.values.includes(value.trim())) fail("bad_value", `${name} ${value} is not one of ${(prop.values ?? []).join(", ")}`);
      props[name] = value.trim();
      return;
    case "pairs": {
      const pairs = parsePairs(value, prop, repairs);
      props[name] = name === "controls"
        ? pairs.map((p) => ({ verb: p.id, timer: p.label }))
        : pairs;
      return;
    }
    case "list": {
      const items = value.split(",").map((s) => s.trim()).filter(Boolean);
      if (prop.maxItems !== undefined && items.length > prop.maxItems) {
        repairs.push("items_trimmed");
        items.length = prop.maxItems;
      }
      props[name] = items;
      return;
    }
    case "duration": {
      const ms = parseDurationMs(value);
      if (ms === null || ms <= 0) fail("bad_value", `${name} ${value} is not a duration`);
      props[name] = ms;
      return;
    }
    default:
      props[name] = value;
  }
}

function colsTrimmed(entry                  , cols          )          {
  return String(entry.attrs.cols).split(",").map((s) => s.trim()).filter(Boolean).length > cols.length;
}

function shapeRows(comp                 , entry                  , props                         , repairs          , closed         , grows = false)       {
  const rowsSpec = comp.rows;
  const lines = props.$rows            ;
  delete props.$rows;
  let cells = lines.map((line) => line.split("|").map((c) => c.trim()));
  const written = Object.hasOwn(entry.attrs, "cols");
  let cols = props.cols            ;

  if (closed && written && !colsTrimmed(entry, cols) && cells.length > 0 && cells.every((r) => r.length === cols.length + 1)) {
    repairs.push("cols_label_added");
    const first = String(comp.props.find((p) => p.name === "cols")?.default ?? "label").split(",")[0].trim();
    cols = [first || "label", ...cols];
  }
  props.cols = cols;

  if (rowsSpec?.tabCell !== undefined && rowsSpec.maxTabs !== undefined) {
    const tabCell = rowsSpec.tabCell;
    const tabs           = [];
    const kept = cells.filter((row) => {
      const tab = row[tabCell] ?? "";
      if (tabs.includes(tab)) return true;
      if (tabs.length >= rowsSpec.maxTabs ) return false;
      tabs.push(tab);
      return true;
    });
    if (kept.length < cells.length) {
      repairs.push("rows_trimmed");
      cells = kept;
    }
  }
  const maxRows = rowsSpec?.maxRows ?? comp.body?.maxItems ?? 20;
  if (cells.length > maxRows) {
    repairs.push("rows_trimmed");
    cells = cells.slice(0, maxRows);
  }
  const cellMax = rowsSpec?.cellMaxChars ?? 64;

  const namingCells = rowsSpec ? [rowsSpec.labelCell, rowsSpec.tabCell] : [0, 1];
  const hiddenMax = rowsSpec?.hiddenCellMaxChars ?? cellMax;
  props.$literalRows = cells.map((row) =>
    row.map((cell, index) => {
      const max = index > 0 && isFetchedPictureSource(cell) ? PICTURE_CELL_MAX_CHARS : namingCells.includes(index) ? cellMax : hiddenMax;
      if (codePoints(cell) > max) {
        repairs.push("text_truncated");
        return cellValue(cutCell(cell, max));
      }
      return cellValue(cell);
    }),
  );
  if (closed && cells.length === 0 && (comp.body?.minItems ?? 0) > 0 && !grows) {
    fail("missing_field", `${comp.name} ${entry.name} has no rows`);
  }
}

function shapeGrowth(entry                  , props                         , formulas                , repairs          , grows         )       {
  const at = formulas.findIndex((f) => f.field === "row");
  const source = at >= 0 ? formulas[at].source : null;
  if (at >= 0) formulas.splice(at, 1);
  const bound = formulas.some((f) => f.field === "rows");
  if (!grows || bound || source === null || typeof props.on !== "string" || liveUiNameProblem(props.on) !== null) {
    if (Object.hasOwn(props, "on") || source !== null) repairs.push("field_dropped");
    delete props.on;
    delete props.row;
    return;
  }
  const cells = splitOutsideQuotes(source, "|");
  let cols = props.cols            ;

  if (Object.hasOwn(entry.attrs, "cols") && !colsTrimmed(entry, cols) && cells.length === cols.length + 1 && ((props.$literalRows                         )?.length ?? 0) === 0) {
    repairs.push("cols_label_added");
    cols = ["label", ...cols];
    props.cols = cols;
  }
  if (cells.length > cols.length) repairs.push("items_trimmed");
  const row                      = cols.map(() => null);
  props.row = row;
  cells.slice(0, cols.length).forEach((cell, i) => {
    if (!cell) return;
    formulas.push({ field: `row.${i}`, source: cell, expect: "any", assign: (t) => { row[i] = t; } });
  });
}

function shapePairs(
  comp                 ,
  entry                  ,
  props                         ,
  formulas                ,
  repairs          ,
  rowNotes                    ,
  closed         ,
)       {
  const body = comp.body ;
  const lines = props.$pairs            ;
  delete props.$pairs;
  const pairs                                                  = [];
  lines.forEach((line, index) => {
    const bar = line.indexOf("|");
    if (bar <= 0) {
      rowNotes.push({ key: entry.key, name: entry.name, code: "bad_value", detail: `line ${index + 1} is not label|value`, kind: "drop" });
      return;
    }
    let label = line.slice(0, bar).trim();
    let value = line.slice(bar + 1).trim();
    if (body.labelMaxChars !== undefined && codePoints(label) > body.labelMaxChars) {
      repairs.push("text_truncated");
      label = cutChars(label, body.labelMaxChars);
    }
    const slot = { label, value: null            };
    const at = pairs.length;
    pairs.push(slot);
    if (value.startsWith("=") && !value.startsWith("==")) {
      formulas.push({
        field: `pairs.${at}`,
        source: value,
        expect: "any",
        assign: (t) => { slot.value = t; },
        rowScoped: () => { pairs[at] = null; },
      });
    } else {
      if (body.itemMaxChars !== undefined && codePoints(value) > body.itemMaxChars) {
        repairs.push("text_truncated");
        value = cutChars(value, body.itemMaxChars);
      }
      slot.value = cellValue(value);
    }
  });
  if (body.maxItems !== undefined && pairs.length > body.maxItems) {
    repairs.push("items_trimmed");
    pairs.length = body.maxItems;
  }
  props.$pairList = pairs;
  if (closed && pairs.length === 0 && entry.body !== null) {
    fail("missing_field", `${comp.name} ${entry.name} has no label|value lines`);
  }
}

function shapePages(comp                 , props                         , repairs          , closed         )       {
  const body = comp.body ;
  const raw = props.$pages;
  delete props.$pages;
  const text = Array.isArray(raw) ? "" : String(raw);
  let pages = text
    .split(/\r?\n/)
    .reduce            ((acc, line) => {
      if (line.trim() === "---") acc.push([]);
      else acc[acc.length - 1].push(line);
      return acc;
    }, [[]])
    .map((lines) => lines.join("\n").trim())
    .filter((page) => page.length > 0);
  if (body.maxItems !== undefined && pages.length > body.maxItems) {
    repairs.push("pages_trimmed");
    pages = pages.slice(0, body.maxItems);
  }
  if (body.itemMaxChars !== undefined) {
    pages = pages.map((page) => {
      if (codePoints(page) <= body.itemMaxChars ) return page;
      repairs.push("text_truncated");
      return cutChars(page, body.itemMaxChars );
    });
  }
  if (closed && pages.length === 0) fail("missing_field", `${comp.name} has no pages`);
  props[body.prop] = pages;
}

function shapeSlots(comp                 , props                         , formulas                , repairs          )       {
  const body = comp.body ;
  const raw = String(props.$slots);
  delete props.$slots;
  let parsed         ;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("parse", "the slots are not a JSON array");
  }
  if (!Array.isArray(parsed)) fail("parse", "the slots are not a JSON array");
  let slots = (parsed             ).filter((s) => s !== null && typeof s === "object" && !Array.isArray(s))                                  ;
  if (slots.length === 0) fail("missing_field", "no Graphic Slot");
  if (body.maxItems !== undefined && slots.length > body.maxItems) {
    repairs.push("slots_trimmed");
    slots = slots.slice(0, body.maxItems);
  }
  slots.forEach((slot, i) => {
    for (const [k, v] of Object.entries(slot)) {
      if (typeof v === "string" && v.trim().startsWith("=") && !v.trim().startsWith("==")) {
        formulas.push({ field: `slots.${i}.${k}`, source: v.trim(), expect: slotFieldType(slot.type, k), assign: (t) => { slot[k] = t; } });
      }
    }
  });
  props[body.prop] = slots;
}

const SLOT_WORD_FIELDS = new Set(["label", "unit", "text", "icon"]);

function slotFieldType(type         , field        )                  {
  if (field === "values") return "text";
  if (SLOT_WORD_FIELDS.has(field) || (type === "metric" && field === "value")) return "any";
  return "number";
}

function compileOnce(
  entries                    ,
  frame             ,
  opts                                                                                                     ,
)

  {
  const failures = new Map                                          ();
  const waiting = new Map                                          ();
  const driverRepairs = new Map                  ();
  const nulled = new Map                ();
  let shaped           = [];
  for (const entry of entries) {
    try {
      shaped.push(shapeEntry(entry, frame, { final: opts.final, picId: opts.picId, pictureBytes: opts.pictureBytes, assetSource: opts.assetSource }));
    } catch (err) {
      if (!(err instanceof RecordFailure)) throw err;
      failures.set(entry.key, { code: err.code, detail: err.message });
    }
  }

  let chars = 0;
  shaped = shaped.filter((s) => {
    chars += s.entry.chars;
    if (chars <= SURFACE_MAX_CHARS) return true;
    failures.set(s.entry.key, { code: "record_chars", detail: `the surface's records pass ${SURFACE_MAX_CHARS} characters` });
    return false;
  });

  const driver = driverRegion(frame);
  const components = shaped.filter((s) => s.component);
  const misplaced = components.filter((s) => isDriving(s.component ) && frame.regions.find((r) => r.name === s.region)?.role !== "driver");
  for (const s of misplaced) {
    const comp = s.component ;
    if (!driver) {
      failures.set(s.entry.key, { code: "no_driver", detail: `${frame.name} has no Region a ${comp.name} can drive` });
      continue;
    }
    const inDriver = components.filter((o) => o !== s && o.region === driver.name && !failures.has(o.entry.key));
    const drivingThere = inDriver.filter((o) => isDriving(o.component ));
    if (drivingThere.some((o) => o.component .drives.drivesAlone) || (comp.drives.drivesAlone && drivingThere.length > 0)) {
      failures.set(s.entry.key, { code: "driver_alone", detail: `the ${driver.name} Region holds pages, which drive alone` });
      continue;
    }
    const from = s.region;
    if (drivingThere.length === 0) {

      for (const o of inDriver) {
        o.region = from;
        driverRepairs.set(o.entry.key, ["driver_moved"]);
      }
    }
    s.region = driver.name;
    driverRepairs.set(s.entry.key, ["driver_moved"]);
  }
  for (const s of components) {
    if (failures.has(s.entry.key)) continue;
    const region = frame.regions.find((r) => r.name === s.region) ;
    if (!fits(s.component , region)) {
      failures.set(s.entry.key, { code: "no_fit", detail: `a ${s.component .name} does not fit the ${region.name} Region` });
    }
  }

  for (const s of components) {
    if (failures.has(s.entry.key)) continue;
    if (isDriving(s.component ) && s.formulas.some((f) => f.field === "show")) {
      s.formulas = s.formulas.filter((f) => f.field !== "show");
      s.repairs.push("field_dropped");
    }
  }

  if (driver) {
    const drivers = components.filter((s) => !failures.has(s.entry.key) && s.region === driver.name && isDriving(s.component ));
    const pages = drivers.find((s) => s.component .drives.drivesAlone);
    if (pages && drivers.length > 1) {
      for (const s of drivers) {
        if (s !== pages && !driverRepairs.has(s.entry.key)) {
          failures.set(s.entry.key, { code: "driver_alone", detail: "pages drive alone" });
        }
      }
    }
  }

  const driverHost = driver
    ? components.find((s) => !failures.has(s.entry.key) && s.region === driver.name && s.component .drives.takesActions)
    : undefined;
  for (const s of components) {
    if (failures.has(s.entry.key)) continue;
    for (const attr of DRIVER_ATTRS.keys()) {
      if (!Object.hasOwn(s.props, attr)) continue;
      if (driver && s.region === driver.name && s.component .drives.takesActions) continue;
      const items = s.props[attr]             ;
      delete s.props[attr];
      if (driverHost && driverHost !== s) {
        const prior = (driverHost.props[attr]                         ) ?? [];
        driverHost.props[attr] = [...prior, ...items];
        s.repairs.push("driver_moved");
      } else {
        s.repairs.push("field_dropped");
      }
    }
  }

  const live = shaped.filter((s) => !failures.has(s.entry.key));

  const lets                                  = {};
  const steppers                                  = {};
  const timers                                  = {};
  const lists                           = {};
  for (const s of live) {
    if (!s.component) {

      if (s.keepOn) steppers[s.entry.name] = "any";
      else lets[s.entry.name] = "any";
      continue;
    }

    if (s.component.rows) lists[s.entry.name] = (s.props.cols                        ) ?? [];
    if (s.component.name === "stepper") {
      const options = s.props.options                         ;
      steppers[s.entry.name] = options && options.length > 0 ? "text" : "number";
    } else if (s.component.behaviours.some((b) => b.name === "countdown" || b.name === "elapsed")) {
      timers[s.entry.name] = (s.props.mode                               ) ?? "countdown";
    }
  }
  const driverRows = driver
    ? live.find((s) => s.region === driver.name && s.component?.rows)
    : undefined;
  const cols = (driverRows?.props.cols                        ) ?? [];
  const names                     = { lets, steppers, timers, cols, lists, inputs: opts.inputs ?? [] };

  const set = createLiveUiFormulaSet();
  const derive                                    = {};
  for (const s of live) {
    const key = s.entry.key;
    const nameFailure = (code        , detail        ) => {
      if (!opts.final && code === "undeclared_name") waiting.set(key, { code, detail });
      else failures.set(key, { code, detail });
    };
    if (!s.component && s.keepOn) {
      compileKept(s, names, set, nameFailure, (code, detail) => failures.set(key, { code, detail }));
      continue;
    }
    if (!s.component) {
      const compiled = compileLiveUiFormula(s.letSource ?? "", names);
      if (!compiled.ok) {
        if (opts.namesFailNull.has(key) && (compiled.code === "undeclared_name" || compiled.code === "ambiguous_name")) {
          derive[s.entry.name] = null;
          nulled.set(key, compiled.detail);
          continue;
        }
        nameFailure(compiled.code, compiled.detail);
        continue;
      }
      s.repairs.push(...compiled.repairs);
      const admit = set.admitLet(s.entry.name, compiled);
      if (!admit.ok) {
        failures.set(key, { code: admit.code, detail: admit.detail });
        continue;
      }
      derive[s.entry.name] = compiled.tree;
      continue;
    }
    let recordFailed = false;
    for (const f of s.formulas) {
      const compiled = compileLiveUiFormula(f.source, names, { expect: f.expect });
      if (!compiled.ok) {
        if (opts.namesFailNull.has(key) && (compiled.code === "undeclared_name" || compiled.code === "ambiguous_name")) {
          f.assign(null);
          nulled.set(key, compiled.detail);
          continue;
        }

        if (f.rowScoped && (opts.final || compiled.code !== "undeclared_name")) {
          f.rowScoped();
          s.rowNotes.push({ key, name: s.entry.name, code: compiled.code, detail: compiled.detail, kind: "drop" });
          continue;
        }
        nameFailure(compiled.code, compiled.detail);
        recordFailed = true;
        break;
      }
      if (f.bindingOnly) {
        const tree = compiled.tree;
        const root = tree && typeof tree === "object" ? Object.keys(tree)[0] : null;
        if (!compiled.binding || (root !== "sel" && root !== "data")) {
          failures.set(key, { code: "bad_value", detail: `${f.field} binds only sel.<column> or data.<key>` });
          recordFailed = true;
          break;
        }
      }
      s.repairs.push(...compiled.repairs);
      const admit = set.admitFormula(`${s.entry.name}.${f.field}`, compiled);
      if (!admit.ok) {
        failures.set(key, { code: admit.code, detail: admit.detail });
        recordFailed = true;
        break;
      }
      f.assign(compiled.tree);
    }
    if (recordFailed) continue;

    const broken = s.component.propRules.find((rule) => {
      const left = s.props[rule.left];
      const right = s.props[rule.right];
      if (typeof left !== "number" || typeof right !== "number") return false;
      return !(
        rule.op === "lt" ? left < right :
        rule.op === "le" ? left <= right :
        rule.op === "gt" ? left > right :
        rule.op === "ge" ? left >= right : left !== right
      );
    });
    if (broken) {
      failures.set(key, { code: broken.code, detail: `${broken.left} must be ${broken.op} ${broken.right}` });
      continue;
    }
    if (s.component.name === "stepper") {
      const admit = set.admitStateKey(s.entry.name, s.props.init);
      if (!admit.ok) failures.set(key, { code: admit.code, detail: admit.detail });
    } else if (typeof s.props.on === "string") {

      const admit = set.admitStateKey(s.entry.name);
      if (!admit.ok) failures.set(key, { code: admit.code, detail: admit.detail });
    } else if (timers[s.entry.name]) {
      const admit = set.admitTimer(s.entry.name);
      if (!admit.ok) failures.set(key, { code: admit.code, detail: admit.detail });
    }
  }
  return { shaped, failures, waiting, driverRepairs, derive, nulled };
}

function compileKept(
  s        ,
  names                    ,
  set                  ,
  nameFailure                                        ,
  failure                                        ,
)       {
  const parts                                           = [
    { field: "be", source: s.letSource ?? "" },
    ...(s.keepOn ?? []).map((w) => ({ field: `on.${w.action}`, source: w.source })),
  ];
  const trees                      = [];
  for (const part of parts) {
    const compiled = compileLiveUiFormula(part.source, names);
    if (!compiled.ok) return nameFailure(compiled.code, compiled.detail);
    s.repairs.push(...compiled.repairs);
    const admit = set.admitFormula(`${s.entry.name}.${part.field}`, compiled);
    if (!admit.ok) return failure(admit.code, admit.detail);
    trees.push(compiled.tree);
  }
  const be = trees[0];
  const admit = set.admitStateKey(s.entry.name, be !== null && typeof be === "object" ? undefined : be);
  if (!admit.ok) return failure(admit.code, admit.detail);
  const on                                    = {};
  (s.keepOn ?? []).forEach((w, i) => { on[w.action] = trees[i + 1]; });
  s.keep = { be, on };
}

function compileSurfaceModel(model                    , options                       = {})                      {
  const final = options.final === true;
  const frame = FRAMES.get(model.frame);
  if (!frame) throw new Error(`unknown frame ${model.frame}`);
  const fallbacks = options.fallbacks ?? new Map                          ();
  let pic = 0;
  const pics = new Map                ();
  const mintPicId = options.picId ?? ((src        ) => {
    if (!pics.has(src)) pics.set(src, `p${(pic += 1)}`);
    return pics.get(src) ;
  });

  const sourceOf = new Map                ();
  const picId = (src        ) => {
    const id = mintPicId(src);
    sourceOf.set(id, src);
    return id;
  };
  const pictureBytes = options.pictureBytes === true;
  const assetSource = options.assetSource ?? (() => null);
  const rowRef = options.rowRef ?? (() => "");

  let entries = model.entries.map((e) => e);
  const notes                     = [];
  const firstFailure = new Map                                          ();
  const usedFallback = new Set        ();
  const waiting = new Set        ();
  const namesFailNull = new Set        ();
  const inputs = options.inputs ?? [];
  let result = compileOnce(entries, frame, { final, picId, pictureBytes, assetSource, namesFailNull, inputs });
  for (let pass = 0; pass < entries.length + 2; pass += 1) {
    if (result.failures.size === 0 && result.waiting.size === 0) break;
    let changed = false;
    const next                     = [];
    for (const entry of entries) {
      const failure = result.failures.get(entry.key) ?? result.waiting.get(entry.key);
      if (!failure) {
        next.push(entry);
        continue;
      }
      changed = true;
      if (result.waiting.has(entry.key) && !result.failures.has(entry.key)) waiting.add(entry.key);
      if (!firstFailure.has(entry.key)) firstFailure.set(entry.key, failure);
      const fallback = fallbacks.get(entry.key);
      if (fallback && !usedFallback.has(entry.key)) {
        usedFallback.add(entry.key);
        next.push(fallback);
      } else if (usedFallback.has(entry.key) && (failure.code === "undeclared_name" || failure.code === "ambiguous_name") && !namesFailNull.has(entry.key)) {

        namesFailNull.add(entry.key);
        next.push(entry);
      }
    }
    if (!changed) break;
    entries = next;
    result = compileOnce(entries, frame, { final, picId, pictureBytes, assetSource, namesFailNull, inputs });
  }

  const placed = result.shaped.filter((s) => !result.failures.has(s.entry.key) && !result.waiting.has(s.entry.key));
  const valid = new Set        ();
  for (const s of placed) if (!firstFailure.has(s.entry.key)) valid.add(s.entry.key);
  for (const [key, failure] of firstFailure) {
    if (waiting.has(key) && !final) continue;
    const entry = model.entries.find((e) => e.key === key);
    notes.push({ key, name: entry?.name ?? key, code: failure.code, detail: failure.detail, kind: "drop" });
  }
  for (const [key, detail] of result.nulled) {
    const entry = model.entries.find((e) => e.key === key);
    if (!firstFailure.has(key)) notes.push({ key, name: entry?.name ?? key, code: "undeclared_name", detail, kind: "drop" });
  }
  for (const s of placed) {
    const codes = [...s.repairs, ...(result.driverRepairs.get(s.entry.key) ?? [])];
    for (const code of [...new Set(codes)]) notes.push({ key: s.entry.key, name: s.entry.name, code, detail: code, kind: "repair" });
    notes.push(...s.rowNotes);
  }

  const regions                                        = {};
  for (const r of frame.regions) regions[r.name] = [];
  const stateSeeds                                  = {};
  const declared           = [];
  const derive                                    = {};
  const keep                                  = {};
  const keptStarts                         = {};
  for (const s of placed) {
    if (s.component) continue;
    if (s.keep) {
      keep[s.entry.name] = s.keep;
      if (typeof s.keep.be === "number") keptStarts[s.entry.name] = s.keep.be;
    } else derive[s.entry.name] = result.derive[s.entry.name] ?? null;
  }

  const openRun = new Map                             ();
  for (const s of placed) {
    if (!s.component) continue;
    const comp = s.component;
    const list = regions[s.region];
    const out = specComponent(s, rowRef, declared);
    const mergeMax = comp.mergeRecords ?? 1;
    if (mergeMax <= 1) {
      openRun.delete(s.region);
      list.push(out);
      continue;
    }

    const row                          = { ref: s.entry.name };
    const lift                          = {};
    for (const [k, v] of Object.entries(out)) {
      if (k === "id" || k === "c") continue;
      if (DRIVER_ATTRS.has(k)) lift[k] = v;
      else row[k] = v;
    }
    for (const seedProp of STATE_SEED_PROPS) {
      const seed = row[seedProp];
      if (typeof seed === "string" || typeof seed === "number") stateSeeds[s.entry.name] = seed;
    }
    const run = openRun.get(s.region);
    if (run && run.c === comp.name) {
      const rows = run.rows             ;
      if (rows.length >= mergeMax) {
        notes.push({ key: s.entry.key, name: s.entry.name, code: "over_cap", detail: `more than ${mergeMax} ${comp.name} rows in one run`, kind: "drop" });
        delete stateSeeds[s.entry.name];
        continue;
      }
      rows.push(row);
      for (const [k, v] of Object.entries(lift)) run[k] = [...((run[k]                         ) ?? []), ...(v             )];
      continue;
    }
    const merged                      = { id: s.entry.name, c: comp.name, ...lift, rows: [row] };
    openRun.set(s.region, merged);
    list.push(merged);
  }

  const timerIds = new Set(placed.filter((s) => s.component && s.component.behaviours.some((b) => b.name === "countdown" || b.name === "elapsed")).map((s) => s.entry.name));
  for (const list of Object.values(regions)) {
    for (const comp of list) {
      if (!Array.isArray(comp.controls)) continue;
      const kept = (comp.controls                                          ).filter((c) => timerIds.has(c.timer));
      if (kept.length !== (comp.controls             ).length && final) {
        notes.push({ key: `id:${comp.id}`, name: comp.id, code: "items_trimmed", detail: "a control names no timer", kind: "repair" });
      }
      if (kept.length > 0) comp.controls = kept;
      else delete comp.controls;
    }
  }
  addStartRows(frame, regions, timerIds);
  markLocalActions(regions, keep, final, notes);
  for (const list of Object.values(regions)) {
    for (const comp of list) {
      for (const attr of DRIVER_ATTRS.keys()) {
        if (!Array.isArray(comp[attr])) continue;
        for (const item of comp[attr]                                                         ) {
          declared.push(item.id ?? `${item.verb}:${item.timer}`);
        }
      }
    }
  }

  const pictures = collectPictures(frame, regions, sourceOf, picId, notes);

  const spec                    = {
    v: 2,
    vocab: specVocab(frame, regions, derive, keep),
    frame: frame.name,
    title: model.title,
    derive,
    data: {},
    regions,
    ...(Object.keys(keep).length > 0 ? { keep } : {}),
  };
  return {
    spec,
    placed: placed.map((s) => s.entry),
    valid,
    waiting,
    notes,
    stateSeeds,
    keptStarts,
    pictures,
    declared,
  };
}

function liveUiDrawsNothing(placed                             )          {
  return !placed.some((entry) => entry.kind === "component");
}

function uiRecordsDrawNothing(records                     )          {
  try {
    const fold = foldUiRecords(records, { final: true });
    if (fold.mode === "patch") return false;
    if (fold.mode !== "new" || !fold.model) return true;
    return liveUiDrawsNothing(compileSurfaceModel(cloneSurfaceModel(fold.model), { final: true }).placed);
  } catch {

    return false;
  }
}

function addStartRows(frame             , regions                                       , timerIds                     )       {
  const driver = driverRegion(frame);
  const host = driver ? regions[driver.name].find((c) => COMPONENTS.get(c.c)?.drives.takesActions) : undefined;
  if (!host) return;
  const started = new Set        ();
  for (const list of Object.values(regions)) {
    for (const comp of list) {
      for (const control of (comp.controls                                                      ) ?? []) {
        if (control.verb === "run") started.add(control.timer);
      }
    }
  }
  const starts                                         = [];
  for (const list of Object.values(regions)) {
    for (const comp of list) {
      if (timerIds.has(comp.id) && waitsForRun(comp) && !started.has(comp.id)) starts.push({ verb: "run", timer: comp.id });
    }
  }
  if (starts.length === 0) return;
  host.controls = [...((host.controls                         ) ?? []), ...starts];
}

function waitsForRun(timer                     )          {
  if (timer.mode === "elapsed") return timer.since === undefined;
  return typeof timer.for === "number";
}

function collectPictures(
  frame             ,
  regions                                       ,
  sourceOf                             ,
  picId                         ,
  notes                    ,
)                     {
  const pictures                     = [];
  const seen = new Set        ();
  const admit = (id        , src        , componentId        , eager         )          => {
    if (seen.has(id)) return true;
    if (seen.size >= LIVEUI_PICTURES_PER_REVISION) return false;
    seen.add(id);
    pictures.push({ id, src, componentId, eager });
    return true;
  };
  const driver = driverRegion(frame);
  const rowsComponent = driver
    ? (regions[driver.name] ?? []).find((c) => Array.isArray(c.rows) && Array.isArray(c.cols))
    : undefined;
  for (const r of frame.regions) {
    const list = regions[r.name];
    for (let i = 0; i < list.length; i += 1) {
      const comp = list[i];
      if (comp.c !== "image") continue;
      if (typeof comp.pic === "string") {
        const src = sourceOf.get(comp.pic);
        if (src === undefined || admit(comp.pic, src, comp.id, true)) continue;
        list.splice(i, 1);
        i -= 1;
        notes.push({ key: `id:${comp.id}`, name: comp.id, code: "over_cap", detail: `more than ${LIVEUI_PICTURES_PER_REVISION} pictures on one surface`, kind: "drop" });
        continue;
      }
      const tree = comp.pic                                       ;
      const column = tree && typeof tree === "object" && typeof tree.sel === "string" ? tree.sel : null;
      if (!column || !rowsComponent) continue;
      const index = (rowsComponent.cols            ).indexOf(column);
      if (index < 0) continue;
      (rowsComponent.rows                   ).forEach((row, rowIndex) => {
        const cell = row.cells[index];
        if (typeof cell !== "string") return;
        const value = cell.trim();
        if (!isFetchedPictureSource(value)) return;
        const id = picId(value);
        row.cells[index] = admit(id, value, comp.id, rowIndex < 3) ? id : "";
      });
    }
  }
  return pictures;
}

function specComponent(
  s        ,
  rowRef                                                             ,
  declared          ,
)                      {
  const comp = s.component ;
  const out                      = { id: s.entry.name, c: comp.name };
  declared.push(s.entry.name);
  for (const [k, v] of Object.entries(s.props)) {
    if (k === "$literalRows" || k === "$pairList") continue;
    out[k] = v;
  }
  if (s.props.$literalRows) {
    const seen = new Map                ();
    out.rows = (s.props.$literalRows                                 ).map((cells) => {
      const label = String(cells[0] ?? "").trim();
      const nth = seen.get(label) ?? 0;
      seen.set(label, nth + 1);
      const ref = rowRef(s.entry.name, label, nth);
      declared.push(ref);
      const row                = { ref, cells };
      return row;
    });
  }
  if (s.props.$pairList) {
    out[comp.body .prop] = (s.props.$pairList                                                   ).filter((p) => p !== null);
  }
  return out;
}

module.exports = { LIVEUI_UNDO_ACTION, LIVEUI_WRITE_SINCE, cloneSurfaceModel, foldUiRecords, LIVEUI_PICTURES_PER_REVISION, LIVEUI_PICTURE_DATA_MAX_CHARS, LIVEUI_PICTURE_DATA_CALL_MAX_CHARS, isFetchedPictureSource, foldLiveUiLocalWrites, cellValue, compileSurfaceModel, liveUiDrawsNothing, uiRecordsDrawNothing };
