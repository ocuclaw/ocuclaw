const { GLASSES_UI_IMAGE_ASSETS } = require("../glasses-ui-descriptors.cjs");
const { LIVEUI_REGISTRY } = require("../liveui-registry/index.cjs");

const { parseUiRecords } = require("../../domain/ui-record-family.cjs");
const { cellValue, compileSurfaceModel, foldLiveUiLocalWrites, foldUiRecords, isFetchedPictureSource } = require("./record-compiler.cjs");

const REG = LIVEUI_REGISTRY;
const FRAMES                                   = new Map(REG.frames.map((f) => [f.name, f]));
const COMPONENTS                                       = new Map(REG.components.map((c) => [c.name, c]));
const OPERATORS                              = new Map(REG.operators.map((o) => [o.name, o.since]));
const RECORD_PROPS                                  = new Map(
  (REG.records.kinds.find((k) => k.kind === "component")?.props ?? []).map((p) => [p.name, p]),
);
const DRIVER_ATTRS                                  = new Map(REG.records.driver.map((p) => [p.name, p]));
const ROOTS = new Set(["state", "data", "sel", "prev", "ref"]);
const NAME_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PLAIN_NUMBER = /^[0-9]+(?:\.[0-9]+)?$/;

const LITERAL_NUMBER = /^-?\d+(?:\.\d+)?$/;
const OPEN_TAG_RE = new RegExp(`<${REG.records.tag}(?:[\\s/>]|$)`);
const CLOSE_TAG = `</${REG.records.tag}>`;

const isCutOrTrim = (code        )          => code === "text_truncated" || code.endsWith("_trimmed");

const TIMER_FOR_SAMPLE_MS = 60_000;

const isObject = (v         )                               =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function isTreeNode(v         )                               {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1) return false;
  const [key] = keys;
  return ROOTS.has(key) ? typeof v[key] === "string" : OPERATORS.has(key) && Array.isArray(v[key]);
}

function dataKeyBinding(v         )                {
  if (!isObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "data" || typeof v.data !== "string") return null;
  const m = /^\/([a-z][a-z0-9_]{0,31})$/.exec(v.data);
  return m ? m[1] : null;
}

function isTimer(component                             )          {
  return !!component && component.behaviours.some((b) => b.name === "countdown" || b.name === "elapsed");
}

function surfaceNames(surface                     )                           {
  const names                           = {
    lets: new Set(Object.keys(isObject(surface.derive) ? surface.derive : {})),
    steppers: new Set(),
    timers: new Map(),
    cols: new Set(),
  };
  const frame = FRAMES.get(surface.frame);
  const driver = frame?.regions.find((r) => r.role === "driver");
  for (const list of Object.values(isObject(surface.regions) ? surface.regions : {})) {
    if (!Array.isArray(list)) continue;
    for (const comp of list) {
      if (!isObject(comp)) continue;
      const component = COMPONENTS.get(String(comp.c));
      if (component && component.name === "stepper") {
        for (const row of Array.isArray(comp.rows) ? comp.rows : []) {
          if (isObject(row) && typeof row.ref === "string") names.steppers.add(row.ref);
        }
      } else if (isTimer(component) && typeof comp.id === "string") {
        names.timers.set(comp.id, comp.mode === "elapsed" ? "elapsed" : "countdown");
      }
    }
  }
  if (driver && isObject(surface.regions) && Array.isArray(surface.regions[driver.name])) {
    const rowsComp = surface.regions[driver.name].find((c) => isObject(c) && COMPONENTS.get(String(c.c))?.rows);
    if (rowsComp && Array.isArray(rowsComp.cols)) {
      for (const col of rowsComp.cols) if (typeof col === "string") names.cols.add(col);
    }
  }
  return names;
}

class NoCallForm extends Error {}

function bareHits(name        , names                          )         {
  return (names.lets.has(name) ? 1 : 0) + (names.steppers.has(name) ? 1 : 0) +
    (names.timers.has(name) ? 1 : 0) + (names.cols.has(name) ? 1 : 0);
}

function rootText(root        , path        , names                          )         {
  if (root === "data" || root === "prev") {
    if (!path.startsWith("/")) throw new NoCallForm();
    const segments = path.slice(1).split("/");
    if (!segments.every((s) => NAME_SEGMENT.test(s))) throw new NoCallForm();
    return `${root}.${segments.join(".")}`;
  }
  if (root === "sel") {
    if (!NAME_SEGMENT.test(path)) throw new NoCallForm();
    return `sel.${path}`;
  }
  if (root === "state") {
    const key = path.startsWith("/") ? path.slice(1) : "";
    if (!NAME_SEGMENT.test(key)) throw new NoCallForm();
    return names.steppers.has(key) && bareHits(key, names) === 1 ? key : `state.${key}`;
  }

  const dot = path.indexOf(".");
  if (dot < 0) {
    if (NAME_SEGMENT.test(path) && names.lets.has(path) && bareHits(path, names) === 1) return path;
    throw new NoCallForm();
  }
  const id = path.slice(0, dot);
  const reading = path.slice(dot + 1);
  if (names.timers.has(id) && NAME_SEGMENT.test(id) && NAME_SEGMENT.test(reading)) return path;
  throw new NoCallForm();
}

function callForm(tree         , names                          )         {
  if (tree === null) return "null";
  if (typeof tree === "boolean") return tree ? "true" : "false";
  if (typeof tree === "number") {
    const text = String(tree);
    if (!Number.isFinite(tree) || Object.is(tree, -0) || !PLAIN_NUMBER.test(text)) throw new NoCallForm();
    return text;
  }
  if (typeof tree === "string") {

    if (/[\r\n<>&]/.test(tree)) throw new NoCallForm();
    if (!tree.includes("'")) return `'${tree}'`;
    if (!tree.includes("\"")) return `"${tree}"`;
    throw new NoCallForm();
  }
  if (!isObject(tree)) throw new NoCallForm();
  const keys = Object.keys(tree);
  if (keys.length !== 1) throw new NoCallForm();
  const [key] = keys;
  const value = tree[key];
  if (ROOTS.has(key)) {
    if (typeof value !== "string") throw new NoCallForm();
    return rootText(key, value, names);
  }
  if (!OPERATORS.has(key) || !Array.isArray(value)) throw new NoCallForm();
  return `${key}(${value.map((arg) => callForm(arg, names)).join(",")})`;
}

function liveUiFormulaText(tree                   , names                           )         {
  try {
    return callForm(tree, names ?? { lets: new Set(), steppers: new Set(), timers: new Map(), cols: new Set() });
  } catch (err) {
    if (!(err instanceof NoCallForm)) throw err;

    return JSON.stringify(tree).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  }
}

function escapeAttr(value        )         {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function durationText(ms        )                {
  if (!Number.isInteger(ms) || ms <= 0 || ms % 1000 !== 0) return null;
  let s = ms / 1000;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}${s ? `${s}s` : ""}`;
}

const marksFormula = (text        )          => {
  const t = text.trim();
  return t.startsWith("=") && !t.startsWith("==");
};

function bodySafe(text        )          {
  return !text.includes(CLOSE_TAG) && !OPEN_TAG_RE.test(text);
}

class RecordWriter {
  lines           = [];
  issues           = [];
  names                          ;
  constructor(names                          ) {
    this.names = names;
  }

  issue(where        , what        )       {
    this.issues.push(`${where}: ${what}`);
  }

  formula(tree         , where = "formula")         {
    const text = liveUiFormulaText(tree                     , this.names);

    if (!text.startsWith("{")) {
      try {
        callForm(tree, this.names);
      } catch (err) {
        if (!(err instanceof NoCallForm)) throw err;
        this.issue(where, `literal ${text} has no formula text`);
      }
    }
    return text;
  }

  attr(where        , name        , value        )         {
    if (/[\r\n]/.test(value)) this.issue(where, `${name} holds a line break`);
    return `${name}="${escapeAttr(value)}"`;
  }

  push(attrs          , body               , where        )       {
    if (body === null) {
      this.lines.push(`<${REG.records.tag} ${attrs.join(" ")}/>`);
      return;
    }
    if (!bodySafe(body)) this.issue(where, "the body holds a record tag");
    this.lines.push(`<${REG.records.tag} ${attrs.join(" ")}>\n${body}\n${CLOSE_TAG}`);
  }

  prop(where        , prop            , value         )                {
    const name = prop.name;
    if (prop.takes === "formula") return this.attr(where, name, this.formula(value));
    if (prop.takes === "text_or_formula") {
      if (typeof value === "string") {
        if (marksFormula(value)) this.issue(where, `${name} is literal text that reads as a formula`);
        return this.attr(where, name, value);
      }
      return this.attr(where, name, `=${this.formula(value)}`);
    }
    if (isTreeNode(value)) {

      this.issue(where, `${name} takes a literal, not a formula`);
      return null;
    }
    switch (prop.type) {
      case "number": {
        const text = typeof value === "number" ? String(value) : "";
        if (!LITERAL_NUMBER.test(text)) this.issue(where, `${name} is not a plain number`);
        return this.attr(where, name, text);
      }
      case "bool":
        if (typeof value !== "boolean") this.issue(where, `${name} is not a boolean`);
        return this.attr(where, name, value === true ? "true" : "false");
      case "duration": {
        const text = typeof value === "number" ? durationText(value) : null;
        if (text === null) {
          this.issue(where, `${name} is not whole seconds`);
          return null;
        }
        return this.attr(where, name, text);
      }
      case "list": {
        const items = Array.isArray(value) ? value.map(String) : [];
        if (!Array.isArray(value) || items.some((i) => i.includes(",") || i !== i.trim() || !i)) {
          this.issue(where, `${name} is not a list of names`);
        }
        return this.attr(where, name, items.join(","));
      }
      case "pairs": {
        const items = Array.isArray(value) ? value : [];
        const parts = items.map((item) => {
          const pair = isObject(item) ? item : {};
          const id = String(name === "controls" ? pair.verb : pair.id);
          const label = String(name === "controls" ? pair.timer : pair.label);
          if (/[|:]/.test(id) || label.includes("|") || label !== label.trim() || !id || !label) {
            this.issue(where, `${name} item ${id} cannot be written`);
          }
          return `${id}:${label}`;
        });
        return this.attr(where, name, parts.join("|"));
      }
      default: {

        const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
        if (typeof value !== "string" && typeof value !== "number") this.issue(where, `${name} is not text`);
        return this.attr(where, name, text);
      }
    }
  }
}

function propFor(component                 , key        )                         {
  return component.props.find((p) => p.name === key) ?? RECORD_PROPS.get(key) ?? DRIVER_ATTRS.get(key);
}

function writeComponent(w              , region        , comp                         )       {
  const id = typeof comp.id === "string" ? comp.id : "";
  const c = typeof comp.c === "string" ? comp.c : "";
  const where = `id:${id}`;
  const component = COMPONENTS.get(c);
  const head = [w.attr(where, "id", id), w.attr(where, "c", c), w.attr(where, "in", region)];
  if (!component) {
    w.issue(where, `unknown component ${c}`);
    w.push(head, null, where);
    return;
  }
  if ((component.mergeRecords ?? 1) > 1) {
    writeMerged(w, region, comp, component);
    return;
  }
  const attrs = [...head];
  let body                = null;
  const form = component.body?.form ?? null;
  const bodyProp = component.body?.prop ?? null;
  for (const [key, value] of Object.entries(comp)) {
    if (key === "id" || key === "c") continue;
    if (form === "rows" && key === "rows") {
      if (!Array.isArray(value)) {
        attrs.push(w.attr(where, "rows", w.formula(value)));
        continue;
      }
      const lines = value.map((row) => {
        const cells = isObject(row) && Array.isArray(row.cells) ? row.cells : [];
        const texts = cells.map((cell) => {
          const text = typeof cell === "number" ? String(cell) : String(cell);
          if (typeof cell === "number" ? !LITERAL_NUMBER.test(text) : typeof cellValue(text) === "number" || /[|\r\n]/.test(text) || text !== text.trim()) {
            w.issue(where, `row cell ${JSON.stringify(text)} cannot be written`);
          }
          return text;
        });
        const line = texts.join("|");
        if (!line.trim()) w.issue(where, "a row has no text");
        return line;
      });
      body = lines.join("\n");
      continue;
    }
    if (form === "rows" && key === "cols") {
      const cols = Array.isArray(value) ? value.map(String) : [];
      const fallback = String(component.props.find((p) => p.name === "cols")?.default ?? "label").split(",").map((s) => s.trim());

      if (JSON.stringify(cols) === JSON.stringify(fallback)) continue;
      const prop = propFor(component, "cols");
      const out = prop ? w.prop(where, prop, cols) : null;
      if (out) attrs.push(out);
      continue;
    }
    if (form === "pairs" && key === bodyProp) {
      const pairs = Array.isArray(value) ? value : [];
      body = pairs.map((pair) => {
        const p = isObject(pair) ? pair : {};
        const label = String(p.label ?? "");
        if (!label || /[|\r\n]/.test(label) || label !== label.trim()) w.issue(where, `fact label ${JSON.stringify(label)} cannot be written`);
        let text        ;
        if (typeof p.value === "string") {
          text = p.value;
          if (marksFormula(text) || /[\r\n]/.test(text) || text !== text.trim() || typeof cellValue(text) === "number") {
            w.issue(where, `fact value ${JSON.stringify(text)} cannot be written`);
          }
        } else if (typeof p.value === "number") {
          text = String(p.value);
          if (!LITERAL_NUMBER.test(text)) w.issue(where, `fact value ${text} cannot be written`);
        } else {
          text = `=${w.formula(p.value)}`;
        }
        return `${label}|${text}`;
      }).join("\n");
      continue;
    }
    if (form === "pages" && key === bodyProp) {
      const pages = Array.isArray(value) ? value.map(String) : [];
      for (const page of pages) {
        if (!page || page !== page.trim() || page.split(/\r?\n/).some((line) => line.trim() === "---")) {
          w.issue(where, "a page cannot be written");
        }
      }
      body = pages.join("\n---\n");
      continue;
    }
    if (form === "slots" && key === bodyProp) {
      const slots = Array.isArray(value) ? value : [];
      const written = slots.map((slot) => {
        if (!isObject(slot)) return slot;
        const out                          = {};
        for (const [k, v] of Object.entries(slot)) {
          if (typeof v === "string" && marksFormula(v)) w.issue(where, `slot ${k} is literal text that reads as a formula`);
          out[k] = isTreeNode(v) ? `=${w.formula(v)}` : v;
        }
        return out;
      });
      body = JSON.stringify(written).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
      continue;
    }
    if (form === "text" && key === bodyProp && typeof value === "string" && /[\r\n]/.test(value)) {
      if (marksFormula(value) || value !== value.trim()) w.issue(where, "the text cannot be written as a body");
      body = value;
      continue;
    }
    if (component.name === "image" && (key === "pic" || key === "asset")) {
      if (key === "pic" && typeof value === "string") {

        if (!isFetchedPictureSource(value) && !/^data:/i.test(value)) w.issue(where, `picture ${value} has no source`);
        attrs.push(w.attr(where, "src", value));
      } else if (key === "pic") {
        attrs.push(w.attr(where, "src", `=${w.formula(value)}`));
      } else {
        attrs.push(w.attr(where, "src", String(value)));
      }
      continue;
    }
    const prop = propFor(component, key);
    if (!prop || prop.takes === "name") {
      w.issue(where, `unknown field ${key}`);
      continue;
    }
    const out = w.prop(where, prop, value);
    if (out) attrs.push(out);
  }
  w.push(attrs, body, where);
}

function writeMerged(w              , region        , comp                         , component                 )       {
  const where = `id:${String(comp.id)}`;
  const rows = Array.isArray(comp.rows) ? comp.rows : [];
  if (rows.length === 0) {
    w.issue(where, `${component.name} has no rows`);
    return;
  }
  const first = isObject(rows[0]) ? rows[0] : {};
  if (first.ref !== comp.id) w.issue(where, "the merged id is not its first row's");
  const lifted = Object.entries(comp).filter(([k]) => DRIVER_ATTRS.has(k));
  for (const [k] of Object.entries(comp)) {
    if (k !== "id" && k !== "c" && k !== "rows" && !DRIVER_ATTRS.has(k)) w.issue(where, `unknown field ${k}`);
  }
  rows.forEach((row, index) => {
    const r = isObject(row) ? row : {};
    const rowId = typeof r.ref === "string" ? r.ref : "";
    const rowWhere = `id:${rowId}`;
    const attrs = [w.attr(rowWhere, "id", rowId), w.attr(rowWhere, "c", component.name), w.attr(rowWhere, "in", region)];
    for (const [key, value] of Object.entries(r)) {
      if (key === "ref") continue;
      const prop = propFor(component, key);
      if (!prop || prop.takes === "name" || DRIVER_ATTRS.has(key)) {
        w.issue(rowWhere, `unknown field ${key}`);
        continue;
      }
      const out = w.prop(rowWhere, prop, value);
      if (out) attrs.push(out);
    }
    if (index === 0) {
      for (const [key, value] of lifted) {
        const out = w.prop(rowWhere, DRIVER_ATTRS.get(key) , value);
        if (out) attrs.push(out);
      }
    }
    w.push(attrs, null, rowWhere);
  });
}

function decompile(surface                     )             {
  const w = new RecordWriter(surfaceNames(surface));
  const title = typeof surface.title === "string" ? surface.title : "";
  if (!title || title !== title.replace(/\s+/g, " ").trim()) w.issue("frame", "the title cannot be written");
  w.lines.push(`<${REG.records.tag} ${w.attr("frame", "frame", String(surface.frame))} ${w.attr("frame", "title", title)}/>`);
  for (const [name, tree] of Object.entries(isObject(surface.derive) ? surface.derive : {})) {
    w.lines.push(`<${REG.records.tag} ${w.attr(`let:${name}`, "let", name)} ${w.attr(`let:${name}`, "be", w.formula(tree))}/>`);
  }
  const frame = FRAMES.get(surface.frame);
  const regions = isObject(surface.regions) ? surface.regions : {};
  const order = frame ? frame.regions.map((r) => r.name) : Object.keys(regions);
  for (const region of order) {
    const list = regions[region];
    if (!Array.isArray(list)) continue;
    for (const comp of list) {
      if (isObject(comp)) writeComponent(w, region, comp);
      else w.issue(region, "a component is not an object");
    }
  }
  return { text: w.lines.join("\n"), issues: w.issues };
}

function storedSurfaceRecords(surface                     )         {
  return decompile(surface).text;
}

function storedSurfaceOf(spec                   )                      {
  spec = foldLiveUiLocalWrites(spec);
  return JSON.parse(JSON.stringify({
    frame: spec.frame,
    title: spec.title,
    derive: spec.derive,
    regions: spec.regions,
  }))                       ;
}

function sampleFor(input                                 , propName        )          {
  if (propName === "for") return TIMER_FOR_SAMPLE_MS;
  if (input && typeof input.min === "number") return input.min;
  return 0;
}

function fillStoredSurface(
  surface                     ,
  values                         ,
  inputs                       ,
)                      {
  const copy = JSON.parse(JSON.stringify(surface))                       ;
  const byKey = new Map((Array.isArray(inputs) ? inputs : []).map((i) => [i.key, i]));
  const vals = isObject(values) ? values : {};
  const fill = (target                         , component                 ) => {
    for (const [key, value] of Object.entries(target)) {
      const prop = component.props.find((p) => p.name === key);
      if (!prop || prop.takes !== "literal") continue;
      const k = dataKeyBinding(value);
      if (k === null) continue;
      const given = vals[k];
      target[key] = given === undefined || given === null ? sampleFor(byKey.get(k), key) : given;
    }
  };
  for (const list of Object.values(isObject(copy.regions) ? copy.regions : {})) {
    if (!Array.isArray(list)) continue;
    for (const comp of list) {
      if (!isObject(comp)) continue;
      const component = COMPONENTS.get(String(comp.c));
      if (!component) continue;
      fill(comp, component);
      if ((component.mergeRecords ?? 1) > 1 && Array.isArray(comp.rows)) {
        for (const row of comp.rows) if (isObject(row)) fill(row, component);
      }
    }
  }
  return copy;
}

function collectDataKeys(value         , out             , depth = 0)       {
  if (depth > 64) return;
  if (Array.isArray(value)) {
    for (const v of value) collectDataKeys(v, out, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === "data" || keys[0] === "prev") && typeof value[keys[0]] === "string") {
    const path = value[keys[0]]          ;
    out.add(path.startsWith("/") ? path.slice(1).split("/")[0] : path);
    return;
  }
  for (const v of Object.values(value)) collectDataKeys(v, out, depth + 1);
}

function liveUiSpecDataKeys(spec                                               )              {
  const keys = new Set        ();
  collectDataKeys(spec.derive, keys);
  collectDataKeys(spec.regions, keys);
  return keys;
}

function collectOperators(value         , out             , depth = 0)       {
  if (depth > 64) return;
  if (Array.isArray(value)) {
    for (const v of value) collectOperators(v, out, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  if (isTreeNode(value)) {
    const [key] = Object.keys(value);
    if (OPERATORS.has(key)) out.add(key);
  }
  for (const v of Object.values(value)) collectOperators(v, out, depth + 1);
}

const reject = (code        , detail        )                           => ({ ok: false, code, detail });

function shapeProblem(surface         )                                  {
  if (!isObject(surface)) return reject("template_surface_invalid", "the surface is not an object");
  const extra = Object.keys(surface).find((k) => !["frame", "title", "derive", "regions"].includes(k));
  if (extra) return reject("template_surface_invalid", `unknown surface field ${extra}`);
  const frame = typeof surface.frame === "string" ? FRAMES.get(surface.frame) : undefined;
  if (!frame) return reject("template_surface_invalid", `unknown frame ${String(surface.frame)}`);
  if (typeof surface.title !== "string") return reject("template_surface_invalid", "the title is not text");
  if (!isObject(surface.derive)) return reject("template_surface_invalid", "derive is not an object");
  if (!isObject(surface.regions)) return reject("template_surface_invalid", "regions is not an object");
  for (const [region, list] of Object.entries(surface.regions)) {
    if (!frame.regions.some((r) => r.name === region)) return reject("unknown_region", `no Region ${region} in ${frame.name}`);
    if (!Array.isArray(list)) return reject("template_surface_invalid", `Region ${region} is not a list`);
    for (const comp of list) {
      if (!isObject(comp) || typeof comp.id !== "string" || typeof comp.c !== "string") {
        return reject("template_surface_invalid", `a component in ${region} has no id or c`);
      }
      if (!COMPONENTS.has(comp.c)) return reject("unknown_component", `unknown component ${comp.c}`);
      if (Object.hasOwn(comp, "actions")) return reject("template_actions_not_allowed", `${comp.id} carries actions (T12)`);
    }
  }
  return null;
}

function literalBindingProblem(surface                     , inputs                                   )                                  {
  const byKey = new Map((inputs ?? []).map((i) => [i.key, i]));
  const check = (target                         , component                 , id        )                                  => {
    for (const [key, value] of Object.entries(target)) {
      const prop = component.props.find((p) => p.name === key);
      if (!prop || prop.takes !== "literal" || !isTreeNode(value)) continue;
      const k = dataKeyBinding(value);
      if (k === null) return reject("bad_value", `${id} ${key} takes a literal, not a formula`);
      if (inputs === undefined) continue;
      const input = byKey.get(k);
      if (!input) return reject("template_input_missing", `${id} ${key} reads data.${k}, which no input declares`);
      if (input.type !== "number") return reject("bad_value", `${id} ${key} reads data.${k}, which is not a number input`);
    }
    return null;
  };
  for (const list of Object.values(surface.regions)) {
    for (const comp of list                                  ) {
      const component = COMPONENTS.get(String(comp.c)) ;
      const problem = check(comp, component, String(comp.id));
      if (problem) return problem;
      if ((component.mergeRecords ?? 1) > 1 && Array.isArray(comp.rows)) {
        for (const row of comp.rows) {
          if (!isObject(row)) continue;
          const rowProblem = check(row, component, String(row.ref));
          if (rowProblem) return rowProblem;
        }
      }
    }
  }
  return null;
}

const PICTURE_LITERAL_FIX =
  'put the bytes in assets.pictures under a name and set src to that name, or make the picture an image input (src="=data.<key>")';

function isPictureSource(value         )          {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return isFetchedPictureSource(text) || /^data:/i.test(text);
}

function pictureProblem(surface                     , assets                               )                                  {
  const known = assets ? new Set([...assets, ...GLASSES_UI_IMAGE_ASSETS]) : null;
  const all = Object.values(surface.regions).flat()                                  ;
  const boundCols = new Set        ();
  for (const comp of all) {
    if (comp.c !== "image") continue;
    if (typeof comp.pic === "string") {
      return reject("template_picture_literal", `${String(comp.id)} holds a fixed picture source; ${PICTURE_LITERAL_FIX}`);
    }
    if (isObject(comp.pic) && typeof comp.pic.sel === "string") boundCols.add(comp.pic.sel);
    if (known && typeof comp.asset === "string" && !known.has(comp.asset)) {
      return reject(
        "template_asset_unknown",
        `${String(comp.id)} names asset ${comp.asset}, which is not in assets.pictures or built in (${GLASSES_UI_IMAGE_ASSETS.join(", ")})`,
      );
    }
  }
  if (boundCols.size === 0) return null;
  for (const comp of all) {
    if (!Array.isArray(comp.cols) || !Array.isArray(comp.rows)) continue;
    const cols = comp.cols             ;
    for (const row of comp.rows) {
      const cells = isObject(row) && Array.isArray(row.cells) ? row.cells : [];
      for (let j = 0; j < cols.length; j += 1) {
        if (typeof cols[j] === "string" && boundCols.has(cols[j]          ) && isPictureSource(cells[j])) {
          return reject("template_picture_literal", `${String(comp.id)} column ${String(cols[j])} holds a fixed picture source; ${PICTURE_LITERAL_FIX}`);
        }
      }
    }
  }
  return null;
}

function firstFailure(notes                    )                          {
  return notes.find((n) => n.kind === "drop" || !isCutOrTrim(n.code)) ?? null;
}

function compileRecordsText(text        ) {
  const { records } = parseUiRecords(text, { final: true });
  const fold = foldUiRecords(records, { final: true, decidedFrame: null });
  if (fold.mode !== "new" || !fold.model || fold.frameRepaired) {
    return { ok: false         , code: "template_surface_invalid", detail: "the records start no surface with a frame record", fold, out: null };
  }
  const out = compileSurfaceModel(fold.model, {
    final: true,
    pictureBytes: true,
    picId: (src        ) => src,
    rowRef: (componentId        , label        , nth        ) => `${componentId}:${label}:${nth}`,
  });
  return { ok: true         , code: "", detail: "", fold, out };
}

function validateStoredSurface(
  surface         ,
  opts                                                                 = {},
)                           {
  const shape = shapeProblem(surface);
  if (shape) return shape;
  const stored = surface                       ;
  const inputs = Array.isArray(opts.inputs) ? opts.inputs : undefined;
  if (inputs) {
    const declared = new Set(inputs.map((i) => i.key));
    const reads = new Set        ();
    collectDataKeys(stored.derive, reads);
    collectDataKeys(stored.regions, reads);
    for (const key of reads) {
      if (key !== "error" && !declared.has(key)) {
        return reject("template_input_missing", `data.${key} names no declared input`);
      }
    }
  }
  const literal = literalBindingProblem(stored, inputs);
  if (literal) return literal;
  const picture = pictureProblem(stored, Array.isArray(opts.assets) ? opts.assets : undefined);
  if (picture) return picture;
  const filled = fillStoredSurface(stored, {}, inputs ?? []);
  const decompiled = decompile(filled);
  if (decompiled.issues.length > 0) {
    return reject("template_surface_unrepresentable", decompiled.issues[0]);
  }
  const compiled = compileRecordsText(decompiled.text);
  if (!compiled.ok) return reject(compiled.code, compiled.detail);
  const failure = firstFailure([...compiled.fold.notes, ...compiled.out .notes]);
  if (failure) return reject(failure.code, `${failure.name}: ${failure.detail}`);
  return { ok: true, vocab: storedSurfaceVocab(stored) };
}

function storedSurfaceVocab(surface                     )         {
  let vocab = FRAMES.get(surface.frame)?.since ?? 1;
  for (const list of Object.values(isObject(surface.regions) ? surface.regions : {})) {
    for (const comp of Array.isArray(list) ? list : []) {
      const since = isObject(comp) ? COMPONENTS.get(String(comp.c))?.since : undefined;
      if (since !== undefined) vocab = Math.max(vocab, since);
    }
  }
  const ops = new Set        ();
  collectOperators(surface.derive, ops);
  collectOperators(surface.regions, ops);
  for (const op of ops) vocab = Math.max(vocab, OPERATORS.get(op) ?? 1);
  return vocab;
}

function compileStoredSurfaceRecords(
  records        ,
  opts                                                                 = {},
)                             {
  if (typeof records !== "string" || !records.trim()) {
    return { ok: false, code: "template_surface_invalid", detail: "records are empty", notes: [] };
  }
  const compiled = compileRecordsText(records);
  if (!compiled.ok) return { ok: false, code: compiled.code, detail: compiled.detail, notes: compiled.fold.notes };
  const notes = [...compiled.fold.notes, ...compiled.out .notes];
  const drop = notes.find((n) => n.kind === "drop");
  if (drop) return { ok: false, code: drop.code, detail: `${drop.name}: ${drop.detail}`, notes };

  const surface = storedSurfaceOf(compiled.out .spec);
  for (const list of Object.values(surface.regions)) {
    for (const comp of list) {
      if (Array.isArray(comp.rows) && COMPONENTS.get(comp.c)?.rows) {
        for (const row of comp.rows                                  ) if (isObject(row)) row.ref = "";
      }
    }
  }
  const checked = validateStoredSurface(surface, opts);
  if (!checked.ok) return { ok: false, code: checked.code, detail: checked.detail, notes };
  return { ok: true, surface, vocab: checked.vocab, notes };
}

module.exports = { liveUiFormulaText, storedSurfaceRecords, storedSurfaceOf, fillStoredSurface, liveUiSpecDataKeys, validateStoredSurface, storedSurfaceVocab, compileStoredSurfaceRecords };
