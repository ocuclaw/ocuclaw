const { GLASSES_UI_IMAGE_ASSETS, getKindDescriptor } = require("./glasses-ui-descriptors.cjs");
const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { substituteTemplate, validateTemplate } = require("./glasses-ui-template.cjs");

const LIVEUI_TEMPLATE_SLOT_TYPES = Object.freeze(["text", "number", "list", "image"]);
const LIVEUI_TEMPLATE_SLOT_MAX = 16;
const LIVEUI_TEMPLATE_SLOT_TEXT_MAX = 4000;
const LIVEUI_TEMPLATE_SLOT_LIST_MAX = 64;
const LIVEUI_TEMPLATE_SLOT_LIST_ITEM_MAX = 200;
const LIVEUI_TEMPLATE_ERROR_PREFIX = "⚠ Update failed: ";

const SLOT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SLOT_COMMON_FIELDS = new Set(["key", "type", "label", "required"]);
const SLOT_BOUND_FIELDS = Object.freeze({
  text: new Set(["maxLength"]),
  number: new Set(["min", "max"]),
  list: new Set(["maxItems"]),
  image: new Set(),
});
const PRESENTATION_FIELDS = new Set(["loading", "empty", "error", "pages"]);
const FRAGMENT_FIELDS = new Set(["title", "body", "items"]);
const PAGES_FRAGMENT_FIELDS = new Set(["pages"]);
const IMAGE_VALUE_FIELDS = new Set(["imageAsset", "imageBase64", "imageWidth", "imageHeight"]);
const CONTROL_FIELDS = Object.freeze([
  "update",
  "timeoutMs",
  "staleAfterMs",
  "queueMode",
  "refresh",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyLiveuiStaticJson(value, state = { keys: 0 }, depth = 0) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (depth > 24) throw new Error("template data is nested too deeply");
  if (Array.isArray(value)) {
    return value.map((item) => copyLiveuiStaticJson(item, state, depth + 1));
  }
  if (!isPlainObject(value)) {
    throw new Error("template data must use plain JSON objects and values");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    state.keys += 1;
    if (state.keys > 2_000) throw new Error("template data contains too many fields");
    const descriptor = descriptors[key];
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new Error(`template field ${JSON.stringify(key)} must be static data`);
    }
    output[key] = copyLiveuiStaticJson(descriptor.value, state, depth + 1);
  }
  return output;
}

function rejected(code, message) {
  return { ok: false, code, message };
}

function firstUnknown(value, allowed) {
  if (!isPlainObject(value)) return null;
  return Object.keys(value).find((key) => !allowed.has(key)) || null;
}

function visitStrings(value, path, visitor) {
  if (typeof value === "string") {
    visitor(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitStrings(entry, `${path}[${index}]`, visitor));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visitStrings(child, path ? `${path}.${key}` : key, visitor);
  }
}

function validateFragment(fragment, path, references, slotByKey, allowError) {
  if (!isPlainObject(fragment)) {
    return rejected("template_presentations_invalid", `${path} must be an object`);
  }
  const unknown = firstUnknown(fragment, FRAGMENT_FIELDS);
  if (unknown) {
    return rejected("template_field_unknown", `unknown ${path} field: ${unknown}`);
  }
  if (fragment.body !== undefined && fragment.items !== undefined) {
    return rejected(
      "template_presentations_invalid",
      `${path} may declare body or items, not both`,
    );
  }
  if (fragment.title !== undefined &&
      (typeof fragment.title !== "string" || fragment.title.length > GLASSES_UI_LIMITS.titleMax)) {
    return rejected(
      "template_presentations_invalid",
      `${path}.title must be a string no longer than ${GLASSES_UI_LIMITS.titleMax} chars`,
    );
  }
  if (fragment.body !== undefined &&
      (typeof fragment.body !== "string" || fragment.body.length > GLASSES_UI_LIMITS.bodyMax)) {
    return rejected(
      "template_presentations_invalid",
      `${path}.body must be a string no longer than ${GLASSES_UI_LIMITS.bodyMax} chars`,
    );
  }
  if (fragment.items !== undefined) {
    if (!Array.isArray(fragment.items) || fragment.items.length === 0 ||
        fragment.items.length > GLASSES_UI_LIMITS.maxItems) {
      return rejected(
        "template_presentations_invalid",
        `${path}.items must contain 1-${GLASSES_UI_LIMITS.maxItems} strings`,
      );
    }
    for (let index = 0; index < fragment.items.length; index += 1) {
      const item = fragment.items[index];
      if (typeof item !== "string" || item.length > GLASSES_UI_LIMITS.itemMax) {
        return rejected(
          "template_presentations_invalid",
          `${path}.items[${index}] must be a string no longer than ${GLASSES_UI_LIMITS.itemMax} chars`,
        );
      }
    }
  }
  let stringError = null;
  visitStrings(fragment, path, (text, stringPath) => {
    if (stringError) return;
    stringError = validateReferenceString(text, stringPath, references, slotByKey, allowError);
  });
  return stringError || { ok: true };
}

function validateReferenceString(text, path, references, slotByKey, allowError) {
  const syntax = validateTemplate(text);
  if (!syntax.ok) return rejected(syntax.code, `${path}: ${syntax.message}`);
  const expression = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = expression.exec(text)) !== null) {
    const referencePath = match[1].split("|")[0].trim();
    if (referencePath === "error") {
      if (!allowError) {
        return rejected(
          "template_error_reference_invalid",
          `{{error}} is only available in presentations.error (${path})`,
        );
      }
      continue;
    }
    if (!referencePath.startsWith("slot.")) continue;
    const key = referencePath.slice("slot.".length);
    if (!SLOT_KEY_RE.test(key) || !slotByKey.has(key)) {
      return rejected(
        "template_slot_undeclared",
        `${path} references undeclared slot: ${key || referencePath}`,
      );
    }
    references.add(key);
  }
  return null;
}

function validatePagesFragment(fragment, references, slotByKey) {
  if (!isPlainObject(fragment)) {
    return rejected("template_presentations_invalid", "presentations.pages must be an object");
  }
  const unknown = firstUnknown(fragment, PAGES_FRAGMENT_FIELDS);
  if (unknown) {
    return rejected("template_field_unknown", `unknown presentations.pages field: ${unknown}`);
  }
  if (!Array.isArray(fragment.pages) || fragment.pages.length === 0 ||
      fragment.pages.length > GLASSES_UI_LIMITS.maxPages) {
    return rejected(
      "template_presentations_invalid",
      `presentations.pages.pages must contain 1-${GLASSES_UI_LIMITS.maxPages} strings`,
    );
  }
  for (let index = 0; index < fragment.pages.length; index += 1) {
    const page = fragment.pages[index];
    if (typeof page !== "string" || page.length > GLASSES_UI_LIMITS.pageMax) {
      return rejected(
        "template_presentations_invalid",
        `presentations.pages.pages[${index}] must be a string no longer than ${GLASSES_UI_LIMITS.pageMax} chars`,
      );
    }
    const referenceError = validateReferenceString(
      page,
      `presentations.pages.pages[${index}]`,
      references,
      slotByKey,
      false,
    );
    if (referenceError) return referenceError;
  }
  return { ok: true };
}

function validateLiveuiTemplateSlotContract(template) {
  const slots = template && template.slots;
  const presentations = template && template.presentations;
  if (slots === undefined && presentations === undefined) return { ok: true };
  if (slots !== undefined && (!Array.isArray(slots) || slots.length > LIVEUI_TEMPLATE_SLOT_MAX)) {
    return rejected(
      "template_slots_invalid",
      `slots must be an array with at most ${LIVEUI_TEMPLATE_SLOT_MAX} declarations`,
    );
  }
  const slotByKey = new Map();
  for (let index = 0; index < (slots || []).length; index += 1) {
    const slot = slots[index];
    if (!isPlainObject(slot)) {
      return rejected("template_slots_invalid", `slots[${index}] must be an object`);
    }
    if (typeof slot.key !== "string" || !SLOT_KEY_RE.test(slot.key)) {
      return rejected(
        "template_slot_key_invalid",
        `slots[${index}].key must match ${SLOT_KEY_RE}`,
      );
    }
    if (slotByKey.has(slot.key)) {
      return rejected("template_slot_duplicate", `duplicate slot key: ${slot.key}`);
    }
    if (!LIVEUI_TEMPLATE_SLOT_TYPES.includes(slot.type)) {
      return rejected("template_slot_type_invalid", `unknown slot type: ${slot.type}`);
    }
    const slotBoundFields = SLOT_BOUND_FIELDS;
    const allowed = new Set([...SLOT_COMMON_FIELDS, ...slotBoundFields[slot.type]]);
    const unknown = firstUnknown(slot, allowed);
    if (unknown) {
      return rejected("template_field_unknown", `unknown slots[${index}] field: ${unknown}`);
    }
    if (slot.label !== undefined &&
        (typeof slot.label !== "string" || slot.label.length > 80)) {
      return rejected("template_slot_bound_invalid", `slots[${index}].label must be at most 80 chars`);
    }
    if (slot.required !== undefined && typeof slot.required !== "boolean") {
      return rejected("template_slots_invalid", `slots[${index}].required must be boolean`);
    }
    if (slot.type === "text" && slot.maxLength !== undefined &&
        (!Number.isInteger(slot.maxLength) || slot.maxLength < 1 ||
         slot.maxLength > LIVEUI_TEMPLATE_SLOT_TEXT_MAX)) {
      return rejected(
        "template_slot_bound_invalid",
        `text slot ${slot.key} maxLength must be 1-${LIVEUI_TEMPLATE_SLOT_TEXT_MAX}`,
      );
    }
    if (slot.type === "number") {
      if (!Number.isFinite(slot.min) || !Number.isFinite(slot.max)) {
        return rejected(
          "template_slot_bound_invalid",
          `number slot ${slot.key} requires finite min and max bounds`,
        );
      }
      if (slot.min > slot.max) {
        return rejected(
          "template_slot_bound_invalid",
          `number slot ${slot.key} min must not exceed max`,
        );
      }
    }
    if (slot.type === "list" && slot.maxItems !== undefined &&
        (!Number.isInteger(slot.maxItems) || slot.maxItems < 1 ||
         slot.maxItems > LIVEUI_TEMPLATE_SLOT_LIST_MAX)) {
      return rejected(
        "template_slot_bound_invalid",
        `list slot ${slot.key} maxItems must be 1-${LIVEUI_TEMPLATE_SLOT_LIST_MAX}`,
      );
    }
    slotByKey.set(slot.key, slot);
  }

  const references = new Set();
  let stringError = null;
  for (const section of ["fields", "defaults"]) {
    visitStrings(template && template[section], section, (text, path) => {
      if (stringError) return;
      stringError = validateReferenceString(text, path, references, slotByKey, false);
    });
  }
  if (stringError) return stringError;

  const mergedKind = template && template.fields && template.fields.kind !== undefined
    ? template.fields.kind
    : template && template.defaults && template.defaults.kind;
  for (const section of ["fields", "defaults"]) {
    const items = template && template[section] && template[section].items;
    if (typeof items !== "string") continue;
    const match = items.match(/^\{\{\s*slot\.([a-z][a-z0-9_]{0,31})\s*\}\}$/);
    const slot = match && slotByKey.get(match[1]);
    if (!slot || slot.type !== "list") {
      return rejected(
        "template_items_invalid",
        `${section}.items string form must be exactly {{slot.<list-slot>}}`,
      );
    }
  }

  if (presentations !== undefined) {
    if (!isPlainObject(presentations)) {
      return rejected("template_presentations_invalid", "presentations must be an object");
    }
    const unknown = firstUnknown(presentations, PRESENTATION_FIELDS);
    if (unknown) {
      return rejected("template_field_unknown", `unknown presentations field: ${unknown}`);
    }
    for (const state of ["loading", "empty", "error"]) {
      if (presentations[state] === undefined) continue;
      const result = validateFragment(
        presentations[state],
        `presentations.${state}`,
        references,
        slotByKey,
        state === "error",
      );
      if (!result.ok) return result;
    }
    if (presentations.pages !== undefined) {
      const result = validatePagesFragment(presentations.pages, references, slotByKey);
      if (!result.ok) return result;
    }
  }

  const imageSlot = template && template.assets && template.assets.imageSlot;
  if (imageSlot !== undefined) {
    if (typeof imageSlot !== "string" || !slotByKey.has(imageSlot) ||
        slotByKey.get(imageSlot).type !== "image") {
      return rejected(
        "template_image_slot_invalid",
        "assets.imageSlot must name a declared image slot",
      );
    }
    references.add(imageSlot);
    for (const field of ["imageAsset", "imageBase64", "imageWidth", "imageHeight"]) {
      if (template.assets[field] !== undefined) {
        return rejected(
          "template_image_slot_conflict",
          "a Template cannot contain both a fixed image and assets.imageSlot",
        );
      }
    }
  }

  const refreshSlot = template && template.recipe && template.recipe.targets &&
    template.recipe.targets.slot;
  if (refreshSlot !== undefined && !slotByKey.has(refreshSlot)) {
    return rejected(
      "template_slot_undeclared",
      `recipe.targets.slot references undeclared slot: ${refreshSlot}`,
    );
  }

  if (mergedKind === "paged_text_surface" &&
      !(presentations && presentations.pages)) {
    return rejected(
      "template_presentations_invalid",
      "paged_text_surface stores pages only in presentations.pages",
    );
  }
  if (presentations && presentations.pages && mergedKind !== "paged_text_surface") {
    return rejected(
      "template_presentations_invalid",
      "presentations.pages is only valid for paged_text_surface",
    );
  }

  for (const slot of slots || []) {
    if (!references.has(slot.key)) {
      return rejected("template_slot_dangling", `slot ${slot.key} is referenced nowhere`);
    }
    if (slot.type === "image" && imageSlot !== slot.key) {
      return rejected(
        "template_image_slot_invalid",
        `image slot ${slot.key} must be referenced by assets.imageSlot`,
      );
    }
  }
  return { ok: true };
}

function validateImageValue(value) {
  let image;
  if (typeof value === "string") {
    image = { imageAsset: value };
  } else if (isPlainObject(value)) {
    const unknown = firstUnknown(value, IMAGE_VALUE_FIELDS);
    if (unknown) return null;
    image = { ...value };
  } else {
    return null;
  }
  if (image.imageAsset !== undefined) {
    if (!GLASSES_UI_IMAGE_ASSETS.includes(image.imageAsset) ||
        Object.keys(image).some((key) => key !== "imageAsset")) return null;
  }
  const descriptor = getKindDescriptor("text_surface");
  const validation = descriptor.validateSpec({
    kind: "text_surface",
    template: "image_caption",
    body: "x",
    ...image,
  });
  return validation.ok
    ? Object.fromEntries(
        Object.entries(validation.spec).filter(([key]) => key.startsWith("image")),
      )
    : null;
}

function validateSlotValue(slot, value) {
  if (slot.type === "text") {
    const maxLength = slot.maxLength === undefined
      ? LIVEUI_TEMPLATE_SLOT_TEXT_MAX
      : slot.maxLength;
    return typeof value === "string" && value.length <= maxLength
      ? { ok: true, value }
      : { ok: false };
  }
  if (slot.type === "number") {
    return typeof value === "number" && Number.isFinite(value) &&
      value >= slot.min && value <= slot.max
      ? { ok: true, value }
      : { ok: false };
  }
  if (slot.type === "list") {
    const maxItems = slot.maxItems === undefined ? 20 : slot.maxItems;
    const valid = Array.isArray(value) && value.length <= maxItems &&
      value.every((item) => typeof item === "string" &&
        item.length <= LIVEUI_TEMPLATE_SLOT_LIST_ITEM_MAX);
    return valid ? { ok: true, value: [...value] } : { ok: false };
  }
  const image = validateImageValue(value);
  return image ? { ok: true, value: image } : { ok: false };
}

function copyAndValidateValues(template, rawValues) {
  if (rawValues === undefined) rawValues = {};
  if (!isPlainObject(rawValues)) {
    return {
      values: {},
      invalid: [{ key: "$values", code: "slot_value_invalid" }],
    };
  }
  const descriptors = Object.getOwnPropertyDescriptors(rawValues);
  const slotByKey = new Map((template.slots || []).map((slot) => [slot.key, slot]));
  const values = {};
  const invalid = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    const slot = slotByKey.get(key);
    if (!slot || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      invalid.push({ key, code: "slot_value_invalid" });
      continue;
    }
    let copied;
    try {
      copied = copyLiveuiStaticJson(descriptor.value);
    } catch (_) {
      invalid.push({ key, code: "slot_value_invalid" });
      continue;
    }
    const checked = validateSlotValue(slot, copied);
    if (!checked.ok) invalid.push({ key, code: "slot_value_invalid" });
    else values[key] = checked.value;
  }
  return { values, invalid };
}

function templateBaseSpec(template) {
  const base = {
    ...(template.defaults || {}),
    ...(template.fields || {}),
    ...(template.assets || {}),
    ...(template.recipe === undefined ? {} : { refresh: template.recipe }),
  };
  delete base.imageSlot;
  if (base.kind === "paged_text_surface" &&
      template.presentations && template.presentations.pages) {
    base.pages = template.presentations.pages.pages;
  }
  return base;
}

function substituteValue(value, data, opts = {}) {
  if (typeof value === "string") {
    return substituteTemplate(value, data, {
      preserveWholeValue: opts.preserveWholeValue === true,
      arraySeparator: ", ",
    });
  }
  if (Array.isArray(value)) return value.map((entry) => substituteValue(entry, data));
  if (!isPlainObject(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = substituteValue(child, data, {
      preserveWholeValue: key === "items" && typeof child === "string",
    });
  }
  return output;
}

function applyImageSlot(template, spec, values) {
  const imageSlot = template.assets && template.assets.imageSlot;
  if (!imageSlot) return spec;
  delete spec.imageAsset;
  delete spec.imageBase64;
  delete spec.imageWidth;
  delete spec.imageHeight;
  if (!values[imageSlot]) {
    delete spec.template;
    return spec;
  }
  spec.template = "image_caption";
  Object.assign(spec, values[imageSlot]);
  return spec;
}

function applyClosedListItemShape(template, spec) {
  const declaredItems = template && template.fields && template.fields.items !== undefined
    ? template.fields.items
    : template && template.defaults && template.defaults.items;
  if (typeof declaredItems !== "string" || !Array.isArray(spec.items)) return spec;
  if (spec.kind === "list_with_details_surface") {
    spec.items = spec.items.map((label) => ({ label }));
  } else if (spec.kind === "checklist_surface") {
    spec.items = spec.items.map((label) => ({ label, checked: false }));
  }
  return spec;
}

function controlsFrom(spec) {
  const controls = {};
  for (const key of CONTROL_FIELDS) {
    if (spec[key] !== undefined) controls[key] = spec[key];
  }
  return controls;
}

function fragmentSpec(template, name, values, errorText) {
  const base = substituteValue(templateBaseSpec(template), {
    slot: values,
    error: errorText,
  });
  const fragment = template.presentations && template.presentations[name];
  if (!fragment) {
    return {
      kind: "text_surface",
      ...(typeof base.title === "string" ? { title: base.title } : {}),
      body: name === "error" ? errorMessage(errorText) : "",
      ...controlsFrom(base),
    };
  }
  const filled = substituteValue(fragment, { slot: values, error: errorText });
  if (Array.isArray(filled.items)) {
    return {
      kind: "list_surface",
      ...(typeof filled.title === "string"
        ? { title: filled.title }
        : typeof base.title === "string" ? { title: base.title } : {}),
      items: filled.items,
      ...controlsFrom(base),
    };
  }
  return {
    kind: "text_surface",
    ...(typeof filled.title === "string"
      ? { title: filled.title }
      : typeof base.title === "string" ? { title: base.title } : {}),
    body: typeof filled.body === "string" ? filled.body : "",
    ...controlsFrom(base),
  };
}

function rawErrorMessage(value) {
  return typeof value === "string"
    ? value
    : value && typeof value.message === "string"
      ? value.message
      : String(value || "unknown error");
}

function errorMessage(value) {
  return LIVEUI_TEMPLATE_ERROR_PREFIX + rawErrorMessage(value).slice(0, 100);
}

function previewLiveuiTemplatePresentation(template, name, values = {}, error = "preview error") {
  const checked = copyAndValidateValues(template, values);
  return fragmentSpec(template, name, checked.values, rawErrorMessage(error));
}

function sampleLiveuiTemplateValues(template) {
  const values = {};
  for (const slot of (template && template.slots) || []) {
    if (slot.type === "text") values[slot.key] = "x";
    else if (slot.type === "number") values[slot.key] = Math.min(slot.max, Math.max(slot.min, 0));
    else if (slot.type === "list") values[slot.key] = ["x"];
    else values[slot.key] = GLASSES_UI_IMAGE_ASSETS[0];
  }
  return values;
}

function fillLiveuiTemplate(template, rawValues = {}, options = {}) {
  const hasContract = !!(
    template &&
    (template.slots !== undefined || template.presentations !== undefined)
  );
  if (!hasContract && (rawValues === undefined ||
      (isPlainObject(rawValues) && Object.keys(rawValues).length === 0)) &&
      !(options && options.error !== undefined)) {
    return { status: "filled", spec: template.spec };
  }

  const checked = copyAndValidateValues(template || {}, rawValues);
  const values = checked.values;
  if (options && options.error !== undefined) {
    const text = rawErrorMessage(options.error).slice(0, 100);
    return { status: "error", spec: fragmentSpec(template, "error", values, text) };
  }
  if (checked.invalid.length > 0) {
    const text = rawErrorMessage(
      `slot_value_invalid: ${checked.invalid.map((entry) => entry.key).join(", ")}`,
    );
    return {
      status: "error",
      spec: fragmentSpec(template, "error", values, text),
      invalid: checked.invalid,
    };
  }

  const missing = (template.slots || [])
    .filter((slot) => slot.required === true &&
      !Object.prototype.hasOwnProperty.call(values, slot.key))
    .map((slot) => slot.key);
  if (missing.length > 0) {
    const loading = !!(template.presentations && template.presentations.loading);
    const status = loading ? "loading" : "empty";
    return {
      status,
      spec: fragmentSpec(template, status, values, ""),
      missing,
    };
  }
  const emptyRequiredList = (template.slots || []).find((slot) =>
    slot.required === true && slot.type === "list" &&
    Array.isArray(values[slot.key]) && values[slot.key].length === 0,
  );
  if (emptyRequiredList) {
    return {
      status: "empty",
      spec: fragmentSpec(template, "empty", values, ""),
    };
  }

  const spec = applyImageSlot(
    template,
    applyClosedListItemShape(
      template,
      substituteValue(templateBaseSpec(template), { slot: values, error: "" }),
    ),
    values,
  );
  return { status: "filled", spec };
}

function liveuiTemplateHasErrorPresentation(template) {
  return !!(template && template.presentations && template.presentations.error);
}

function readLiveuiTemplateRefreshPath(output, path) {
  if (typeof path !== "string" || !path.trim()) return undefined;
  const data = output && typeof output === "object" && !Array.isArray(output)
    ? { ...output, output }
    : { output };
  return substituteTemplate(`{{${path.trim()}}}`, data, { preserveWholeValue: true });
}

module.exports = { LIVEUI_TEMPLATE_SLOT_TYPES, LIVEUI_TEMPLATE_SLOT_MAX, LIVEUI_TEMPLATE_SLOT_TEXT_MAX, LIVEUI_TEMPLATE_SLOT_LIST_MAX, LIVEUI_TEMPLATE_SLOT_LIST_ITEM_MAX, LIVEUI_TEMPLATE_ERROR_PREFIX, copyLiveuiStaticJson, validateLiveuiTemplateSlotContract, previewLiveuiTemplatePresentation, sampleLiveuiTemplateValues, fillLiveuiTemplate, liveuiTemplateHasErrorPresentation, readLiveuiTemplateRefreshPath };
