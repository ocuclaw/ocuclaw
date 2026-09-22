const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { LIVEUI_TEMPLATE_SLOT_JSON_MAX_BYTES, copyLiveuiStaticJson } = require("./glasses-ui-template-slots.cjs");

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

function rejectUnsupported(message) {
  const err = new Error(message);
  err.code = "save_ui_unsupported_kind";
  throw err;
}

function requiredTextSlot(key, maxLength) {
  return { key, type: "text", maxLength, required: true };
}

function presentationTitle(hasTitle) {
  return hasTitle ? { title: "{{slot.title}}" } : {};
}

function itemLabels(kind, items) {
  if (!Array.isArray(items) || items.length === 0) {
    rejectUnsupported(`${kind} has no reusable item labels`);
  }
  if (kind === "list_surface") {
    if (!items.every((item) => typeof item === "string")) {
      rejectUnsupported("list_surface items are not strings");
    }
    return [...items];
  }
  if (!items.every((item) => item && typeof item === "object" &&
      !Array.isArray(item) && typeof item.label === "string")) {
    rejectUnsupported(`${kind} items do not have the closed label shape`);
  }

  return items.map((item) => item.label);
}

const GRAPHIC_SLOT_STRUCTURAL_KEYS = new Set(["type", "label", "icon"]);

const GRAPHIC_VALUE_NUMBER_BOUND = 1e9;

function graphicValueSlotDeclaration(fieldValue) {
  if (typeof fieldValue === "string") return { type: "text" };
  if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
    return { type: "number", min: -GRAPHIC_VALUE_NUMBER_BOUND, max: GRAPHIC_VALUE_NUMBER_BOUND };
  }

  if (Array.isArray(fieldValue)) return { type: "json", maxBytes: LIVEUI_TEMPLATE_SLOT_JSON_MAX_BYTES };
  return null;
}

function abstractGraphicSlots(rawSlots) {
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) {
    rejectUnsupported("graphic has no reusable slots");
  }
  const slots = [];
  const slotValues = {};
  const templateSlots = rawSlots.map((rawSlot, index) => {
    if (!rawSlot || typeof rawSlot !== "object" || Array.isArray(rawSlot)) {
      rejectUnsupported(`graphic.slots[${index}] is not a reusable slot object`);
    }
    const out = {};
    for (const key of Object.keys(rawSlot)) {
      if (GRAPHIC_SLOT_STRUCTURAL_KEYS.has(key)) {
        out[key] = rawSlot[key];
        continue;
      }
      const declaration = graphicValueSlotDeclaration(rawSlot[key]);
      if (!declaration) {
        rejectUnsupported(`graphic.slots[${index}].${key} is not reusable template data`);
      }
      const slotKey = `graphic${index}_${key}`;
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

function pagedBody(pages) {
  if (!Array.isArray(pages) || pages.length === 0 ||
      !pages.every((page) => typeof page === "string")) {
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

function abstractSurfaceToTemplate(spec, options) {
  let source;
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
  const fields = { kind: targetKind };
  for (const key of CONTROL_FIELDS) {
    if (source[key] !== undefined) fields[key] = source[key];
  }

  const slots = [];
  const slotValues = {};
  const isImageCaption = source.template === "image_caption";
  const isGraphic = source.template === "graphic";
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
  }

  const assets = {};
  if (isGraphic) {

    assets.template = "graphic";
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
  const presentations = {
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

module.exports = { abstractSurfaceToTemplate };
