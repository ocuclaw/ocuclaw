const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { LIVEUI_TEMPLATE_SLOT_JSON_MAX_BYTES, copyLiveuiStaticJson } = require("./glasses-ui-template-slots.cjs");
const { LIVEUI_REGISTRY } = require("./liveui-registry/index.cjs");
const { LIVEUI_INPUTS_MAX, LIVEUI_INPUT_KEY_RE, checkLiveUiInputValue, validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");

const { classifyPictureSource } = require("./liveui-pictures/picture-source.cjs");

const SUPPORTED_KINDS = new Set([
  "text_surface",
  "list_surface",
  "list_with_details_surface",
  "checklist_surface",
  "paged_text_surface",
]);
const LIST_KINDS = new Set([
  "list_surface",
  "list_with_details_surface",
  "checklist_surface",
]);
const CONTROL_FIELDS = Object.freeze([
  "timeoutMs",
  "staleAfterMs",
  "queueMode",
  "update",
]);

function rejectUnsupported(message     ) {
  const err      = new Error(message);
  err.code = "save_ui_unsupported_kind";
  throw err;
}

function requiredTextSlot(key     , maxLength     ) {
  return { key, type: "text", maxLength, required: true };
}

function presentationTitle(hasTitle     ) {
  return hasTitle ? { title: "{{slot.title}}" } : {};
}

function itemLabels(kind     , items     ) {
  if (!Array.isArray(items) || items.length === 0) {
    rejectUnsupported(`${kind} has no reusable item labels`);
  }
  if (kind === "list_surface") {
    if (!items.every((item     ) => typeof item === "string")) {
      rejectUnsupported("list_surface items are not strings");
    }
    return [...items];
  }
  if (!items.every((item     ) => item && typeof item === "object" &&
      !Array.isArray(item) && typeof item.label === "string")) {
    rejectUnsupported(`${kind} items do not have the closed label shape`);
  }

  return items.map((item     ) => item.label);
}

const GRAPHIC_SLOT_STRUCTURAL_KEYS = new Set(["type", "label", "icon"]);

const GRAPHIC_VALUE_NUMBER_BOUND = 1e9;

function graphicValueSlotDeclaration(fieldValue     ) {
  if (typeof fieldValue === "string") return { type: "text" };
  if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
    return { type: "number", min: -GRAPHIC_VALUE_NUMBER_BOUND, max: GRAPHIC_VALUE_NUMBER_BOUND };
  }

  if (Array.isArray(fieldValue)) return { type: "json", maxBytes: LIVEUI_TEMPLATE_SLOT_JSON_MAX_BYTES };
  return null;
}

function abstractGraphicSlots(rawSlots     ) {
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
    rejectUnsupported("graphic has no reusable slots");
  }
  const slots      = [];
  const slotValues      = {};
  const templateSlots = rawSlots.map((rawSlot     , index     ) => {
    if (!rawSlot || typeof rawSlot !== "object" || Array.isArray(rawSlot)) {
      rejectUnsupported(`graphic.slots[${index}] is not a reusable slot object`);
    }
    const out      = {};
    for (const key of Object.keys(rawSlot)) {
      if (GRAPHIC_SLOT_STRUCTURAL_KEYS.has(key)) {
        out[key] = rawSlot[key];
        continue;
      }
      const declaration = graphicValueSlotDeclaration(rawSlot[key]);
      if (!declaration) {
        rejectUnsupported(`graphic.slots[${index}].${key} is not reusable template data`);
      }
      const slotKey = `graphic${index}_${key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)}`;
      slots.push({ key: slotKey, required: true, ...declaration });
      slotValues[slotKey] = rawSlot[key];
      out[key] = `{{slot.${slotKey}}}`;
    }
    if (typeof out.type !== "string") {
      rejectUnsupported(`graphic.slots[${index}] has no type`);
    }
    return out;
  });
  return { graphicField: { slots: templateSlots }, slots, slotValues };
}

function pagedBody(pages     ) {
  if (!Array.isArray(pages) || pages.length === 0 ||
      !pages.every((page     ) => typeof page === "string")) {
    rejectUnsupported("paged_text_surface pages are not reusable text");
  }
  const body = pages.join("\n\n");
  if (body.length > GLASSES_UI_LIMITS.bodyMax) {
    rejectUnsupported(
      `paged content is ${body.length} chars; text surface max is ${GLASSES_UI_LIMITS.bodyMax}`,
    );
  }
  return body;
}

function abstractSurfaceToTemplate(spec     , options     ) {
  let source     ;
  try {
    source = copyLiveuiStaticJson(spec);
  } catch (_) {
    rejectUnsupported("surface spec is not static data");
  }
  const kind = source && source.kind;
  if (!SUPPORTED_KINDS.has(kind)) {
    rejectUnsupported(`surface kind is not reusable: ${String(kind || "unknown")}`);
  }

  const targetKind = kind === "paged_text_surface" ? "text_surface" : kind;
  const fields      = { kind: targetKind };
  for (const key of CONTROL_FIELDS) {
    if (source[key] !== undefined) fields[key] = source[key];
  }

  const slots      = [];
  const slotValues      = {};
  const isImageCaption = source.template === "image_caption";
  const isGraphic = source.template === "graphic" || source.template === "graphic_v2";
  const isDurationPicker = source.template === "duration_picker";
  const hasTitle = typeof source.title === "string" && source.title.length > 0;
  if (hasTitle) {
    slots.push(requiredTextSlot("title", GLASSES_UI_LIMITS.titleMax));
    fields.title = "{{slot.title}}";
    slotValues.title = source.title;
  }

  if (targetKind === "text_surface") {
    const body = kind === "paged_text_surface"
      ? pagedBody(source.pages)
      : source.body;
    if (typeof body !== "string") {
      rejectUnsupported(`${kind} has no reusable body`);
    }
    slots.push(requiredTextSlot(
      "body",
      isGraphic
        ? GLASSES_UI_LIMITS.graphicCaptionMax
        : isImageCaption ? GLASSES_UI_LIMITS.imageCaptionMax : GLASSES_UI_LIMITS.bodyMax,
    ));
    fields.body = "{{slot.body}}";
    slotValues.body = body;

    if (isGraphic) {
      const graphicAbstraction = abstractGraphicSlots(source.graphic && source.graphic.slots);
      fields.graphic = graphicAbstraction.graphicField;
      slots.push(...graphicAbstraction.slots);
      Object.assign(slotValues, graphicAbstraction.slotValues);
    }
  } else {
    const labels = itemLabels(kind, source.items);
    slots.push({
      key: "items",
      type: "list",
      maxItems: GLASSES_UI_LIMITS.maxItems,
      required: true,
    });
    fields.items = "{{slot.items}}";
    slotValues.items = labels;
    if(isDurationPicker) {
      slots.push({key:"duration_picker",type:"json",maxBytes:LIVEUI_TEMPLATE_SLOT_JSON_MAX_BYTES,required:true});
      fields.durationPicker="{{slot.duration_picker}}";
      slotValues.duration_picker=source.durationPicker;
    }
  }

  const assets      = {};
  if (isGraphic) {

    assets.template = source.template;
  } else if (isDurationPicker) {
    assets.template = "duration_picker";
  } else if (typeof source.imageAsset === "string") {
    assets.template = "image_caption";
    assets.imageAsset = source.imageAsset;
  } else if (typeof source.imageBase64 === "string" || typeof source.imageUrl === "string") {
    slots.push({ key: "image", type: "image", required: false });
    assets.imageSlot = "image";
    if (typeof source.imageBase64 === "string") {
      slotValues.image = {
        imageBase64: source.imageBase64,
        imageWidth: source.imageWidth,
        imageHeight: source.imageHeight,
      };
    }
  }

  const titleFragment = presentationTitle(hasTitle);
  const presentations      = {
    loading: LIST_KINDS.has(targetKind)
      ? { ...titleFragment, items: ["Loading…"] }
      : { ...titleFragment, body: "Loading…" },
    empty: { ...titleFragment, body: "Nothing to show yet" },
    error: { ...titleFragment, body: "{{error}}" },
  };
  const template = {
    schemaVersion: 1,
    templateId: options && options.templateId,
    name: options && options.name,
    fields,
    assets,
    slots,
    presentations,
  };
  return {
    template,
    slotValues,
    ...(kind === "paged_text_surface"
      ? { note: "paged content abstracted to a text surface" }
      : {}),
  };
}

const V2_FRAMES = new Map(LIVEUI_REGISTRY.frames.map((f) => [f.name, f]));
const V2_COMPONENTS                                       = new Map(LIVEUI_REGISTRY.components.map((c) => [c.name, c]));
const V2_OPERATORS = new Map(LIVEUI_REGISTRY.operators.map((o) => [o.name, o]));

const DATA_ROOTS = new Set(["data", "prev"]);
const ROOT_NAMES = new Set(LIVEUI_REGISTRY.roots.map((r) => r.name          ));

const ERROR_INPUT_KEY = "error";

const LIST_INPUT_MAX_ITEMS = 20;
const INPUT_LABEL_MAX_CHARS = 64;
const STEPPER_BOUNDS = ["min", "max", "by"];

class ComposedSaveFailure extends Error {
  code        ;
  constructor(code        , message        ) {
    super(message);
    this.code = code;
  }
}

const saveFail = (code        , message        )        => {
  throw new ComposedSaveFailure(code, message);
};

const isObject = (value         )                                   =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isBareLiteral = (value         )                                     =>
  typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));

const literalType = (value                           )             =>
  typeof value === "number" ? "number" : typeof value === "boolean" ? "bool" : "text";

const bindData = (key        )                    => ({ data: `/${key}` });

function idKey(...parts                        )         {
  return parts.map(String).join("_").toLowerCase().replace(/[^a-z0-9]/g, "_");
}

const fieldPart = (field        )         => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

function inputLabel(label         )                     {
  if (typeof label !== "string" || !label.trim()) return undefined;
  return [...label.trim()].slice(0, INPUT_LABEL_MAX_CHARS).join("");
}

function scalarHint(type                                    )              {
  return type === "number" || type === "text" || type === "bool" ? { type } : null;
}

function pointerHead(pointer        )                                              {
  if (!pointer.startsWith("/")) return null;
  const parts = pointer.slice(1).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  return { key: parts[0], next: parts.length > 1 ? parts[1] : null };
}

function scanReads(tree         , hint             , reads                       )       {
  if (Array.isArray(tree)) {
    for (const item of tree) scanReads(item, null, reads);
    return;
  }
  if (!isObject(tree)) return;
  const keys = Object.keys(tree);
  if (keys.length === 1) {
    const name = keys[0];
    const arg = tree[name];
    if (DATA_ROOTS.has(name) && typeof arg === "string") {
      const head = pointerHead(arg);
      if (!head) return;
      const readHint = head.next === null ? hint : /^\d+$/.test(head.next) ? { type: "list"         , cols: null } : null;
      const read = reads.get(head.key) ?? { key: head.key, hints: [] };
      if (readHint) read.hints.push(readHint);
      reads.set(head.key, read);
      return;
    }
    const op = V2_OPERATORS.get(name);
    if (op && Array.isArray(arg)) {
      arg.forEach((a, i) => scanReads(a, scalarHint(i < op.params.length ? op.params[i] : op.rest), reads));
      return;
    }
    if (ROOT_NAMES.has(name)) return;
  }
  for (const value of Object.values(tree)) scanReads(value, null, reads);
}

function scanComponentReads(comp                     , reg                 , reads                       )       {
  for (const [prop, value] of Object.entries(comp)) {
    if (prop === "id" || prop === "c" || prop === "actions") continue;
    if (prop === "rows" && reg.rows) {
      scanReads(value, { type: "list", cols: Array.isArray(comp.cols) ? (comp.cols            ) : null }, reads);
    } else if (prop === "rows" && reg.drives.rowType === "stepper" && Array.isArray(value)) {
      for (const row of value) {
        if (!isObject(row)) continue;
        for (const [field, tree] of Object.entries(row)) {
          scanReads(tree, STEPPER_BOUNDS.includes(field) ? { type: "number" } : null, reads);
        }
      }
    } else if (reg.body?.form === "slots" && prop === reg.body.prop && Array.isArray(value)) {

      for (const slot of value) if (isObject(slot)) for (const tree of Object.values(slot)) scanReads(tree, { type: "number" }, reads);
    } else if (reg.body?.form === "pages" && prop === reg.body.prop) {
      if (Array.isArray(value)) for (const page of value) scanReads(page, { type: "text" }, reads);
    } else if (prop === "pic") {
      scanReads(value, { type: "image" }, reads);
    } else if (prop === "show") {
      scanReads(value, { type: "bool" }, reads);
    } else {
      scanReads(value, scalarHint(reg.props.find((p) => p.name === prop)?.resultType), reads);
    }
  }
}

function scalarsType(items           )             {
  const present = items.filter((v) => v !== null && v !== undefined && v !== "");
  if (present.length > 0 && present.every((v) => typeof v === "number")) return "number";
  if (present.length > 0 && present.every((v) => typeof v === "boolean")) return "bool";
  return "text";
}

function listShape(current         , cols                 , imageCols                     )                                             {
  const rows = Array.isArray(current) ? current : [];
  if (rows.length > 0 && rows.every((r) => r === null || isBareLiteral(r))) return { of: scalarsType(rows) };
  const names = cols ?? [...new Set(rows.filter(isObject).flatMap((r) => Object.keys(r)))];
  if (names.length === 0) return { of: "text" };
  const fields                            = {};
  names.forEach((name, index) => {
    fields[name] = imageCols.has(name)
      ? "image"
      : scalarsType(rows.map((r) => (isObject(r) ? r[name] : Array.isArray(r) ? r[index] : undefined)));
  });
  return { fields };
}

function dataKeyInput(
  read          ,
  declared                                 ,
  current         ,
  imageCols                     ,
)                      {
  if (declared) {
    const input                      = { ...declared, key: read.key };

    if (input.type === "list" && input.fields && imageCols.size > 0) {
      input.fields = { ...input.fields };
      for (const col of imageCols) input.fields[col] = "image";
    }
    return input;
  }
  const hint = read.hints.find((h) => h.type === "list") ?? read.hints[0] ?? null;
  if (hint && hint.type === "list") {
    return { key: read.key, type: "list", required: true, maxItems: LIST_INPUT_MAX_ITEMS, ...listShape(current, hint.cols, imageCols) };
  }
  if (hint) return hint.type === "image" ? { key: read.key, type: "image", required: false } : { key: read.key, type: hint.type, required: true };
  if (isBareLiteral(current)) return { key: read.key, type: literalType(current), required: true };
  if (Array.isArray(current)) {
    return { key: read.key, type: "list", required: true, maxItems: LIST_INPUT_MAX_ITEMS, ...listShape(current, null, imageCols) };
  }
  return { key: read.key, type: "text", required: true };
}

function storedVocab(surface                     )         {
  let vocab = V2_FRAMES.get(surface.frame)?.since ?? 1;
  const visit = (node         )       => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isObject(node)) return;
    const keys = Object.keys(node);
    const op = keys.length === 1 ? V2_OPERATORS.get(keys[0]) : undefined;
    if (op && Array.isArray(node[keys[0]])) vocab = Math.max(vocab, op.since);
    Object.values(node).forEach(visit);
  };
  visit(surface.derive);
  for (const list of Object.values(surface.regions)) {
    for (const comp of list) {
      vocab = Math.max(vocab, V2_COMPONENTS.get(comp.c)?.since ?? vocab);
      visit(comp);
    }
  }
  return vocab;
}

function pictureValue(pic         , sources                                  )                     {
  if (typeof pic !== "string") return undefined;
  if (Object.hasOwn(sources, pic)) {
    const src = sources[pic];
    return typeof src === "string" && classifyPictureSource(src).kind !== "invalid" ? src : undefined;
  }
  const kind = classifyPictureSource(pic).kind;
  return kind === "url" || kind === "file" || kind === "bytes" ? pic : undefined;
}

function pictureRunValue(input                     , value         , sources                                  )          {
  if (value === undefined || value === null) return value;
  if (input.type === "image") return pictureValue(value, sources);
  const fields = input.type === "list" && input.fields ? input.fields : null;
  const imageFields = fields ? Object.keys(fields).filter((name) => fields[name] === "image") : [];
  if (imageFields.length === 0 || !Array.isArray(value)) return value;
  return value.map((row) => {
    if (!isObject(row)) return row;
    const out                          = { ...row };
    for (const name of imageFields) {
      if (out[name] === undefined || out[name] === null) continue;
      const src = pictureValue(out[name], sources);
      if (src === undefined) delete out[name];
      else out[name] = src;
    }
    return out;
  });
}

function abstractComposedSurfaceToTemplate(
  spec                   ,
  opts                            = {},
)                           {
  try {
    return abstractComposed(spec, opts);
  } catch (err) {
    if (err instanceof ComposedSaveFailure) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

function abstractComposed(spec                   , opts                           )                           {
  if (!isObject(spec) || spec.v !== 2 || typeof spec.frame !== "string" || typeof spec.title !== "string" || !isObject(spec.regions)) {
    return saveFail("save_ui_not_composed", "the surface is not a composed V2 spec");
  }
  const frame = V2_FRAMES.get(spec.frame) ?? saveFail("save_ui_not_composed", `unknown frame ${spec.frame}`);
  let copy                   ;
  try {
    copy = JSON.parse(JSON.stringify(spec));
  } catch {
    return saveFail("save_ui_not_composed", "the surface spec is not static data");
  }
  const data                          = isObject(copy.data) ? copy.data : {};
  const derive                                    = isObject(copy.derive) ? copy.derive : {};
  const regionOrder = [
    ...frame.regions.map((r) => r.name).filter((name) => Object.hasOwn(copy.regions, name)),
    ...Object.keys(copy.regions).filter((name) => !frame.regions.some((r) => r.name === name)),
  ];
  const regions                                        = {};
  for (const name of regionOrder) regions[name] = Array.isArray(copy.regions[name]) ? copy.regions[name] : [];
  const components                                                             = [];
  for (const name of regionOrder) {
    for (const comp of regions[name]) {
      const reg = V2_COMPONENTS.get(comp?.c) ?? saveFail("save_ui_not_composed", `unknown component ${String(comp?.c)}`);
      components.push({ comp, reg });
    }
  }

  const reads = new Map                  ();
  scanReads(derive, null, reads);
  for (const { comp, reg } of components) scanComponentReads(comp, reg, reads);

  const driver = frame.regions.find((r) => r.role === "driver");
  const rowsHost = driver
    ? (regions[driver.name] ?? []).find((c) => V2_COMPONENTS.get(c.c)?.rows && Array.isArray(c.cols) && c.rows !== undefined)
    : undefined;
  const imageCols = new Set        ();
  for (const { comp } of components) {
    if (isObject(comp.pic) && typeof comp.pic.sel === "string") imageCols.add(comp.pic.sel);
  }
  const hostImageCols = (comp                     )                      => (comp === rowsHost ? imageCols : new Set());

  const inputs = new Map                             ();
  const origins = new Map                ();
  const values                          = {};
  const sources = opts.pictureSources ?? {};
  const add = (input                     , value         , origin        )                    => {
    const key = input.key;
    if (key.length > 32) saveFail("save_ui_input_key_invalid", `${origin} makes input key ${key}, over 32 characters`);
    if (!LIVEUI_INPUT_KEY_RE.test(key) || key === ERROR_INPUT_KEY) {
      saveFail("save_ui_input_key_invalid", `${origin} makes input key ${key}, which is not ${LIVEUI_INPUT_KEY_RE.source} or is reserved`);
    }
    if (inputs.has(key)) saveFail("save_ui_input_key_clash", `${origin} and ${origins.get(key)} both make input ${key}`);
    inputs.set(key, input);
    origins.set(key, origin);
    if (value !== undefined) values[key] = value;
    return bindData(key);
  };

  for (const [name, tree] of Object.entries(derive)) {
    if (!isBareLiteral(tree)) continue;
    derive[name] = add({ key: idKey(name), type: literalType(tree), required: true }, tree, `let ${name}`);
  }

  for (const { comp, reg } of components) {
    const id = comp.id;

    delete comp.actions;
    const body = reg.body;

    if (body?.form === "text" && isBareLiteral(comp[body.prop])) {
      comp[body.prop] = add({ key: idKey(id), type: "text", required: true }, String(comp[body.prop]), `${reg.name} ${id}`);
    }

    if (body?.form === "pages" && Array.isArray(comp[body.prop])) {
      const pages = comp[body.prop]             ;
      const multi = pages.length > 1;
      comp[body.prop] = pages.map((page, i) =>
        isBareLiteral(page)
          ? add({ key: multi ? idKey(id, i + 1) : idKey(id), type: "text", required: true }, String(page), `page ${i + 1} of ${id}`)
          : page,
      );
    }

    if (body?.form === "pairs") {
      const pairs = Array.isArray(comp[body.prop]) ? (comp[body.prop]             ) : [];
      const oneLine = Object.hasOwn(comp, "value");
      const multi = pairs.length + (oneLine ? 1 : 0) > 1;
      pairs.forEach((pair, i) => {
        if (!isObject(pair) || !isBareLiteral(pair.value)) return;
        const input                      = { key: multi ? idKey(id, i + 1) : idKey(id), type: literalType(pair.value), required: true };
        const label = inputLabel(pair.label);
        if (label) input.label = label;
        pair.value = add(input, pair.value, `line ${i + 1} of ${id}`);
      });
      if (oneLine && isBareLiteral(comp.value)) {
        const n = pairs.length + 1;
        const input                      = { key: multi ? idKey(id, n) : idKey(id), type: literalType(comp.value), required: true };
        const label = inputLabel(comp.label);
        if (label) input.label = label;
        comp.value = add(input, comp.value, `line ${n} of ${id}`);
      }
    }

    if (reg.rows && Array.isArray(comp.rows)) {
      const cols = Array.isArray(comp.cols) && comp.cols.length > 0 ? (comp.cols            ) : ["label"];
      const pictureCols = hostImageCols(comp);
      const rows = (comp.rows                                ).map((row) => (Array.isArray(row?.cells) ? row.cells : []));
      const fields                            = {};
      cols.forEach((col, j) => {
        fields[col] = pictureCols.has(col) ? "image" : scalarsType(rows.map((cells) => cells[j]));
      });
      const runRows = rows.map((cells) => {
        const out                          = {};
        cols.forEach((col, j) => {
          const cell = cells[j];
          if (cell === undefined || cell === null) return;
          if (fields[col] === "image") {
            const src = pictureValue(cell, sources);
            if (src !== undefined) out[col] = src;
          } else {
            out[col] = fields[col] === "text" ? String(cell) : cell;
          }
        });
        return out;
      });
      comp.rows = add(
        { key: idKey(id), type: "list", required: true, maxItems: LIST_INPUT_MAX_ITEMS, fields },
        runRows,
        `${reg.name} ${id}`,
      );
    }

    if (reg.drives.rowType === "stepper" && Array.isArray(comp.rows)) {
      for (const row of comp.rows             ) {
        if (!isObject(row) || typeof row.ref !== "string" || !isBareLiteral(row.init)) continue;
        const input                      = { key: idKey(row.ref), type: literalType(row.init), required: true };
        const label = inputLabel(row.label);
        if (label) input.label = label;
        if (input.type === "number") {
          if (typeof row.min === "number") input.min = row.min;
          if (typeof row.max === "number") input.max = row.max;
        }
        row.init = add(input, row.init, `stepper row ${row.ref}`);
      }
    }

    for (const prop of reg.props) {
      if (prop.type !== "duration" || typeof comp[prop.name] !== "number") continue;
      const input                      = { key: idKey(id), type: "number", required: true, min: 1 };
      const label = inputLabel(typeof comp.label === "string" ? `${comp.label} (ms)` : undefined);
      if (label) input.label = label;
      comp[prop.name] = add(input, comp[prop.name], `${reg.name} ${id} ${prop.name}`);
    }

    if (body?.form === "slots" && Array.isArray(comp[body.prop])) {
      const slots = comp[body.prop]             ;
      const multi = slots.length > 1;
      slots.forEach((slot, i) => {
        if (!isObject(slot)) return;
        for (const [field, reading] of Object.entries(slot)) {
          if (GRAPHIC_SLOT_STRUCTURAL_KEYS.has(field)) continue;
          const key = multi ? idKey(id, i + 1, fieldPart(field)) : idKey(id, fieldPart(field));
          const origin = `graphic ${id} slot ${i + 1} ${field}`;
          if (isBareLiteral(reading)) {
            slot[field] = add({ key, type: literalType(reading), required: true }, reading, origin);
          } else if (Array.isArray(reading)) {
            if (!reading.every(isBareLiteral)) {
              saveFail("save_ui_unsupported_reading", `${origin} holds nested values, which no input type carries (T5)`);
            }
            const of = scalarsType(reading);
            const run = of === "text" ? reading.map(String) : reading;
            slot[field] = add({ key, type: "list", required: true, maxItems: LIST_INPUT_MAX_ITEMS, of }, run, origin);
          }
        }
      });
    }

    if (typeof comp.pic === "string") {
      const input                      = { key: idKey(id), type: "image", required: false };
      const label = inputLabel(comp.alt);
      if (label) input.label = label;
      comp.pic = add(input, pictureValue(comp.pic, sources), `picture ${id}`);
    }
  }

  const declared = new Map                             ();
  for (const input of Array.isArray(opts.inputs) ? opts.inputs : []) {
    if (isObject(input) && typeof input.key === "string") declared.set(input.key, input);
  }
  for (const read of reads.values()) {
    if (read.key === ERROR_INPUT_KEY) continue;
    const bound = rowsHost && isObject(rowsHost.rows) && rowsHost.rows.data === `/${read.key}` ? imageCols : new Set        ();
    const current = Object.hasOwn(data, read.key) ? data[read.key] : undefined;
    const input = dataKeyInput(read, declared.get(read.key), current, bound);
    add(input, pictureRunValue(input, current, sources), `data.${read.key}`);
  }

  const list = [...inputs.values()];
  if (list.length > LIVEUI_INPUTS_MAX) {
    saveFail("save_ui_too_many_inputs", `the surface makes ${list.length} inputs, more than ${LIVEUI_INPUTS_MAX}: ${list.map((i) => i.key).join(", ")}`);
  }
  const checked = validateLiveUiInputs(list);
  if (!checked.ok) {
    const code =
      checked.code === "input_key_duplicate" ? "save_ui_input_key_clash"
        : checked.code === "inputs_too_many" ? "save_ui_too_many_inputs"
          : checked.code === "input_key_invalid" || checked.code === "input_key_reserved" ? "save_ui_input_key_invalid"
            : "save_ui_inputs_invalid";
    saveFail(code, checked.message);
  }
  const contract = (checked                                               ).inputs;

  const byKey = new Map(contract.map((i) => [i.key, i]));
  for (const key of Object.keys(values)) {
    const input = byKey.get(key);
    const result = input ? checkLiveUiInputValue(input, values[key], { files: true, assets: true }) : null;
    if (result && result.ok) values[key] = result.value;
    else delete values[key];
  }

  const surface                      = { frame: copy.frame, title: copy.title, derive, regions };

  const after = new Map                  ();
  scanReads(surface.derive, null, after);
  scanReads(surface.regions, null, after);
  for (const key of after.keys()) {
    if (key !== ERROR_INPUT_KEY && !byKey.has(key)) saveFail("save_ui_unbound_data", `data.${key} names no input`);
  }

  return { ok: true, surface, inputs: contract, values, vocab: storedVocab(surface) };
}

module.exports = { abstractSurfaceToTemplate, abstractComposedSurfaceToTemplate };
