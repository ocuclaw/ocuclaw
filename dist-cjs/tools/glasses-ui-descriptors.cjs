const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");

function validateTitle(obj) {
  if (typeof obj.title === "undefined") return null;
  if (typeof obj.title !== "string") {
    return { ok: false, code: "title_too_long", message: "title must be a string" };
  }
  if (obj.title.length > GLASSES_UI_LIMITS.titleMax) {
    return {
      ok: false,
      code: "title_too_long",
      message: `title is ${obj.title.length} chars; max ${GLASSES_UI_LIMITS.titleMax}`,
    };
  }
  return null;
}

const textSurfaceDescriptor = {
  kind: "text_surface",
  refreshTargets: ["body"],
  schemaBranch: {
    title: "text_surface",
    type: "object",
    required: ["kind", "body"],
    properties: {
      kind: { const: "text_surface" },
      title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
      body: { type: "string", maxLength: GLASSES_UI_LIMITS.bodyMax },
      refresh: undefined,
    },
  },
  validateSpec(obj) {
    const titleErr = validateTitle(obj);
    if (titleErr) return titleErr;
    const body = obj.body;
    if (typeof body !== "string") {
      return { ok: false, code: "missing_field", message: "text_surface requires body (string)" };
    }
    if (body.length > GLASSES_UI_LIMITS.bodyMax) {
      return {
        ok: false,
        code: "body_too_long",
        message: `body is ${body.length} chars; max ${GLASSES_UI_LIMITS.bodyMax}`,
      };
    }
    const spec = { kind: "text_surface", body };
    if (typeof obj.title === "string") spec.title = obj.title;
    return { ok: true, spec };
  },
};

const listSurfaceDescriptor = {
  kind: "list_surface",
  refreshTargets: ["items"],
  schemaBranch: {
    title: "list_surface",
    type: "object",
    required: ["kind", "items"],
    properties: {
      kind: { const: "list_surface" },
      title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
      items: {
        type: "array",
        minItems: 1,
        maxItems: GLASSES_UI_LIMITS.maxItems,
        items: { type: "string", maxLength: GLASSES_UI_LIMITS.itemMax },
      },
      refresh: undefined,
    },
  },
  validateSpec(obj) {
    const titleErr = validateTitle(obj);
    if (titleErr) return titleErr;
    const items = obj.items;
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, code: "missing_field", message: "list_surface requires items (non-empty array)" };
    }
    if (items.length > GLASSES_UI_LIMITS.maxItems) {
      return {
        ok: false,
        code: "too_many_items",
        message: `${items.length} items; max ${GLASSES_UI_LIMITS.maxItems}`,
      };
    }
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (typeof item !== "string") {
        return { ok: false, code: "item_too_long", message: `items[${i}] must be a string` };
      }
      if (item.length > GLASSES_UI_LIMITS.itemMax) {
        return {
          ok: false,
          code: "item_too_long",
          message: `items[${i}] is ${item.length} chars; max ${GLASSES_UI_LIMITS.itemMax}`,
        };
      }
    }
    const spec = { kind: "list_surface", items };
    if (typeof obj.title === "string") spec.title = obj.title;
    return { ok: true, spec };
  },
};

const listWithDetailsSurfaceDescriptor = {
  kind: "list_with_details_surface",
  refreshTargets: ["items"],
  schemaBranch: {
    title: "list_with_details_surface",
    type: "object",
    required: ["kind", "items"],
    properties: {
      kind: { const: "list_with_details_surface" },
      title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
      items: {
        type: "array",
        minItems: 1,
        maxItems: GLASSES_UI_LIMITS.maxItems,
        items: {
          type: "object",
          required: ["label"],
          properties: {
            label: { type: "string", maxLength: GLASSES_UI_LIMITS.itemMax },
            body: { type: "string", maxLength: GLASSES_UI_LIMITS.detailBodyMax },
          },
        },
      },
      refresh: undefined,
    },
  },
  validateSpec(obj) {
    const titleErr = validateTitle(obj);
    if (titleErr) return titleErr;

    const rawItems = obj.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return {
        ok: false,
        code: "missing_field",
        message: "list_with_details_surface requires items (non-empty array)",
      };
    }
    if (rawItems.length > GLASSES_UI_LIMITS.maxItems) {
      return {
        ok: false,
        code: "too_many_items",
        message: `${rawItems.length} items; max ${GLASSES_UI_LIMITS.maxItems}`,
      };
    }
    const parallelBodies =
      Array.isArray(obj.details) ? obj.details
      : Array.isArray(obj.itemDetails) ? obj.itemDetails
      : Array.isArray(obj.bodies) ? obj.bodies
      : null;
    const items = rawItems.map((entry, i) => {
      if (typeof entry === "string") {
        const sibling = parallelBodies ? parallelBodies[i] : undefined;

        if (typeof sibling === "string") {
          return { label: entry, body: sibling };
        }
        if (sibling && typeof sibling === "object" && typeof sibling.body === "string") {
          return { label: entry, body: sibling.body };
        }

        return { label: entry };
      }
      return entry;
    });
    let totalBodyChars = 0;
    const normalizedItems = [];
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (!it || typeof it !== "object") {
        return { ok: false, code: "missing_field", message: `items[${i}] must be an object {label, body?}` };
      }
      if (typeof it.label !== "string") {
        return { ok: false, code: "missing_field", message: `items[${i}].label is required` };
      }
      if (it.label.length > GLASSES_UI_LIMITS.itemMax) {
        return {
          ok: false,
          code: "item_too_long",
          message: `items[${i}].label is ${it.label.length} chars; max ${GLASSES_UI_LIMITS.itemMax}`,
        };
      }
      const normalized = { label: it.label };
      if (it.body !== undefined) {
        if (typeof it.body !== "string") {
          return { ok: false, code: "detail_body_too_long", message: `items[${i}].body must be a string` };
        }
        if (it.body.length > GLASSES_UI_LIMITS.detailBodyMax) {
          return {
            ok: false,
            code: "detail_body_too_long",
            message: `items[${i}].body is ${it.body.length} chars; max ${GLASSES_UI_LIMITS.detailBodyMax}`,
          };
        }
        totalBodyChars += it.body.length;
        normalized.body = it.body;
      }
      normalizedItems.push(normalized);
    }
    if (totalBodyChars > GLASSES_UI_LIMITS.totalDetailPayloadMax) {
      return {
        ok: false,
        code: "total_payload_too_large",
        message: `bodies sum to ${totalBodyChars} chars; max ${GLASSES_UI_LIMITS.totalDetailPayloadMax}`,
      };
    }
    const spec = { kind: "list_with_details_surface", items: normalizedItems };
    if (typeof obj.title === "string") spec.title = obj.title;
    return { ok: true, spec };
  },
};

const GLASSES_UI_KIND_DESCRIPTORS = [
  textSurfaceDescriptor,
  listSurfaceDescriptor,
  listWithDetailsSurfaceDescriptor,
];

function getKindDescriptor(kind) {
  return GLASSES_UI_KIND_DESCRIPTORS.find((d) => d.kind === kind);
}

function listKindStrings() {
  return GLASSES_UI_KIND_DESCRIPTORS.map((d) => d.kind);
}

function buildOneOfBranches() {
  return GLASSES_UI_KIND_DESCRIPTORS.map((d) => d.schemaBranch);
}

module.exports = { GLASSES_UI_KIND_DESCRIPTORS, getKindDescriptor, listKindStrings, buildOneOfBranches };
