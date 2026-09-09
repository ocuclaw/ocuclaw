const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");

const GLASSES_UI_IMAGE_ASSETS = ["hermes_welcome"];

const GLASSES_UI_LIST_ITEM_SCHEMA = {
  type: "string",
  maxLength: GLASSES_UI_LIMITS.itemMax,
};

const GLASSES_UI_DETAIL_ITEM_SCHEMA = {
  type: "object",
  required: ["label"],
  properties: {
    label: { type: "string", maxLength: GLASSES_UI_LIMITS.itemMax },
    body: { type: "string", maxLength: GLASSES_UI_LIMITS.detailBodyMax },
  },
  additionalProperties: false,
};

const GLASSES_UI_CHECKLIST_ITEM_SCHEMA = {
  type: "object",
  required: ["label"],
  properties: {
    label: { type: "string", maxLength: GLASSES_UI_LIMITS.itemMax },
    checked: { type: "boolean" },
  },
  additionalProperties: false,
};

const GLASSES_UI_CHILD_KINDS = Object.freeze(["text_surface", "paged_text_surface"]);
const CHILD_ALLOWED_KEYS = Object.freeze(["kind", "title", "body", "pages"]);

const GLASSES_UI_CHILD_SURFACE_SCHEMA = {
  anyOf: [
    { type: "null" },
    {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: [...GLASSES_UI_CHILD_KINDS] },
        title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
        body: { type: "string", maxLength: GLASSES_UI_LIMITS.bodyMax },
        pages: {
          type: "array",
          minItems: 1,
          maxItems: GLASSES_UI_LIMITS.maxChildPages,
          items: { type: "string", maxLength: GLASSES_UI_LIMITS.pageMax },
        },
      },
      additionalProperties: false,
    },
  ],
};

const GLASSES_UI_CHILDREN_SCHEMA = {
  type: "array",
  maxItems: GLASSES_UI_LIMITS.maxItems,
  items: GLASSES_UI_CHILD_SURFACE_SCHEMA,
  description:
    "Preloaded Child Surface: an optional deeper page per row, parallel to items " +
    "(children[i] belongs to items[i]; null = no child). A tap on that row opens the " +
    "child on the glasses at once with no agent turn; Back pops it. Use it when you " +
    "already know the full text the wearer wants to READ (release notes or a briefing). " +
    "Preload at most 8 reading rows. For a 20-row list, keep every item but put children " +
    "on at most the first 8 rows (null elsewhere), or omit children. Omit children for " +
    "selection questions: a tap must answer the question. Omit children when detail needs " +
    "fresh data or a tool call; fetch after selection, then render with update:push. Leaf " +
    `only: text_surface {title?, body} or paged_text_surface {title?, pages (max ${GLASSES_UI_LIMITS.maxChildPages})}; ` +
    `no refresh, no children inside a child; all children together max ${GLASSES_UI_LIMITS.totalChildPayloadMax} chars. ` +
    "Rows with a child show a trailing › glyph. You learn which child the wearer " +
    "opened from THIS call's window_expired result (opened_child: {surfaceId, itemIndex}). " +
    "Cannot be combined with refresh.",
};

function childPayloadChars(spec) {
  let n = typeof spec.title === "string" ? spec.title.length : 0;
  if (typeof spec.body === "string") n += spec.body.length;
  if (Array.isArray(spec.pages)) for (const page of spec.pages) n += page.length;
  return n;
}

function validateChildren(obj, itemCount) {
  const raw = obj.children;
  if (raw === undefined) return { ok: true, children: null };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      code: "children_invalid",
      message: "children must be an array parallel to items (null for rows without a child)",
    };
  }
  if (raw.length > itemCount) {
    return {
      ok: false,
      code: "children_length_mismatch",
      message: `children has ${raw.length} entries; items has ${itemCount} (children[i] belongs to items[i])`,
    };
  }
  const children = [];
  let total = 0;
  let hasChild = false;
  for (let i = 0; i < itemCount; i += 1) {
    const child = raw[i];
    if (child === undefined || child === null) {
      children.push(null);
      continue;
    }
    if (typeof child !== "object" || Array.isArray(child)) {
      return { ok: false, code: "children_invalid", message: `children[${i}] must be null or an object` };
    }
    if (!GLASSES_UI_CHILD_KINDS.includes(child.kind)) {
      return {
        ok: false,
        code: "child_kind_invalid",
        message:
          `children[${i}].kind must be one of ${GLASSES_UI_CHILD_KINDS.join(", ")}; got ${JSON.stringify(child.kind)} ` +
          "(a child is a leaf: no lists, one level deep)",
      };
    }
    const unknown = Object.keys(child).find((key) => !CHILD_ALLOWED_KEYS.includes(key));
    if (unknown) {
      return {
        ok: false,
        code: "child_field_unknown",
        message: `children[${i}].${unknown} is not supported (a child carries only kind, title, body or pages)`,
      };
    }
    const result = getKindDescriptor(child.kind).validateSpec(child);
    if (!result.ok) {
      return { ok: false, code: `child_${result.code}`, message: `children[${i}]: ${result.message}` };
    }
    if (Array.isArray(result.spec.pages) && result.spec.pages.length > GLASSES_UI_LIMITS.maxChildPages) {
      return {
        ok: false,
        code: "child_too_many_pages",
        message: `children[${i}] has ${result.spec.pages.length} pages; max ${GLASSES_UI_LIMITS.maxChildPages}`,
      };
    }
    total += childPayloadChars(result.spec);
    children.push(result.spec);
    hasChild = true;
  }
  if (total > GLASSES_UI_LIMITS.totalChildPayloadMax) {
    return {
      ok: false,
      code: "total_child_payload_too_large",
      message: `children sum to ${total} chars; max ${GLASSES_UI_LIMITS.totalChildPayloadMax}`,
    };
  }
  return { ok: true, children: hasChild ? children : null };
}

function defineKindItemGrammar(schema) {
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  const allowedKeys = Object.freeze(Object.keys(properties));
  const typeRules = allowedKeys.map((key) => Object.freeze({
    key,
    type: properties[key].type,
  }));
  return Object.freeze({
    schema,
    valueType: schema.type,
    allowedKeys,
    requiredTypeRules: Object.freeze(typeRules.filter((rule) => required.has(rule.key))),
    optionalTypeRules: Object.freeze(typeRules.filter((rule) => !required.has(rule.key))),
  });
}

const listItemGrammar = defineKindItemGrammar(GLASSES_UI_LIST_ITEM_SCHEMA);
const detailItemGrammar = defineKindItemGrammar(GLASSES_UI_DETAIL_ITEM_SCHEMA);
const checklistItemGrammar = defineKindItemGrammar(GLASSES_UI_CHECKLIST_ITEM_SCHEMA);

function decodedBase64Length(value = "") {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64Bytes(value = "") {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const effective = value.replace(/=+$/, "");
  const output = [];
  let buffer = 0;
  let bits = 0;
  for (const char of effective) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  return output;
}

function pngDimensions(value = "") {
  const bytes = decodeBase64Bytes(value);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!bytes || bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return null;
  if (bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const width = ((bytes[16] << 24) >>> 0) + (bytes[17] << 16) + (bytes[18] << 8) + bytes[19];
  const height = ((bytes[20] << 24) >>> 0) + (bytes[21] << 16) + (bytes[22] << 8) + bytes[23];
  return { width, height };
}

function validateImageCaptionTemplate(obj = Object.create(null), body = "") {
  if (obj.template !== "image_caption") {
    return {
      ok: false,
      code: "invalid_template",
      message: `text_surface template must be "image_caption", got ${JSON.stringify(obj.template)}`,
    };
  }
  if (obj.title !== undefined) {
    return {
      ok: false,
      code: "image_caption_title_unsupported",
      message: "image_caption uses one caption line and does not accept title",
    };
  }
  if (body.length === 0 || body.length > GLASSES_UI_LIMITS.imageCaptionMax) {
    return {
      ok: false,
      code: "image_caption_too_long",
      message: `image_caption body must be 1-${GLASSES_UI_LIMITS.imageCaptionMax} chars`,
    };
  }
  if (obj.refresh !== undefined) {
    return {
      ok: false,
      code: "image_caption_refresh_unsupported",
      message: "image_caption is a one-shot image transfer; re-render explicitly instead of using refresh",
    };
  }

  const hasAsset = obj.imageAsset !== undefined;
  const hasInline = obj.imageBase64 !== undefined || obj.imageWidth !== undefined || obj.imageHeight !== undefined;
  if (hasAsset === hasInline) {
    return {
      ok: false,
      code: "image_source_invalid",
      message: "image_caption requires exactly one image source: imageAsset or imageBase64+imageWidth+imageHeight",
    };
  }
  if (hasAsset) {
    if (typeof obj.imageAsset !== "string" || !GLASSES_UI_IMAGE_ASSETS.includes(obj.imageAsset)) {
      return {
        ok: false,
        code: "image_asset_unknown",
        message: `imageAsset must be one of: ${GLASSES_UI_IMAGE_ASSETS.join(", ")}`,
      };
    }
    return {
      ok: true,
      spec: {
        kind: "text_surface",
        template: "image_caption",
        body,
        imageAsset: obj.imageAsset,
      },
    };
  }

  const imageWidth = obj.imageWidth;
  const imageHeight = obj.imageHeight;
  if (typeof imageWidth !== "number" || !Number.isInteger(imageWidth) || imageWidth < GLASSES_UI_LIMITS.imageWidthMin || imageWidth > GLASSES_UI_LIMITS.imageWidthMax) {
    return {
      ok: false,
      code: "image_dimensions_invalid",
      message: `imageWidth must be an integer from ${GLASSES_UI_LIMITS.imageWidthMin}-${GLASSES_UI_LIMITS.imageWidthMax}`,
    };
  }
  if (typeof imageHeight !== "number" || !Number.isInteger(imageHeight) || imageHeight < GLASSES_UI_LIMITS.imageHeightMin || imageHeight > GLASSES_UI_LIMITS.imageHeightMax) {
    return {
      ok: false,
      code: "image_dimensions_invalid",
      message: `imageHeight must be an integer from ${GLASSES_UI_LIMITS.imageHeightMin}-${GLASSES_UI_LIMITS.imageHeightMax}`,
    };
  }
  if (typeof obj.imageBase64 !== "string" || obj.imageBase64.length > GLASSES_UI_LIMITS.imagePayloadBase64Max) {
    return {
      ok: false,
      code: "image_payload_invalid",
      message: `imageBase64 must be a base64 string no longer than ${GLASSES_UI_LIMITS.imagePayloadBase64Max} chars`,
    };
  }
  const decodedLength = decodedBase64Length(obj.imageBase64);
  if (decodedLength === null || decodedLength > GLASSES_UI_LIMITS.imagePayloadMax) {
    return {
      ok: false,
      code: "image_payload_invalid",
      message: `imageBase64 decodes to ${decodedLength ?? "invalid"} bytes; max ${GLASSES_UI_LIMITS.imagePayloadMax}`,
    };
  }
  const dimensions = pngDimensions(obj.imageBase64);
  if (!dimensions || dimensions.width !== imageWidth || dimensions.height !== imageHeight) {
    return {
      ok: false,
      code: "image_format_invalid",
      message: "imageBase64 must be a PNG whose IHDR dimensions match imageWidth and imageHeight",
    };
  }
  return {
    ok: true,
    spec: {
      kind: "text_surface",
      template: "image_caption",
      body,
      imageBase64: obj.imageBase64,
      imageWidth,
      imageHeight,
    },
  };
}

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
  itemGrammar: null,
  refreshTargets: ["body"],
  schemaBranch: {
    title: "text_surface",
    type: "object",
    required: ["kind", "body"],
    properties: {
      kind: { const: "text_surface" },
      title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
      body: { type: "string", maxLength: GLASSES_UI_LIMITS.bodyMax },
      template: { type: "string", enum: ["image_caption"] },
      imageAsset: { type: "string", enum: GLASSES_UI_IMAGE_ASSETS },
      imageBase64: { type: "string", maxLength: GLASSES_UI_LIMITS.imagePayloadBase64Max },
      imageWidth: { type: "integer", minimum: GLASSES_UI_LIMITS.imageWidthMin, maximum: GLASSES_UI_LIMITS.imageWidthMax },
      imageHeight: { type: "integer", minimum: GLASSES_UI_LIMITS.imageHeightMin, maximum: GLASSES_UI_LIMITS.imageHeightMax },
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
    if (obj.template !== undefined) {
      return validateImageCaptionTemplate(obj, body);
    }
    if (
      obj.imageAsset !== undefined || obj.imageBase64 !== undefined ||
      obj.imageWidth !== undefined || obj.imageHeight !== undefined
    ) {
      return {
        ok: false,
        code: "image_template_required",
        message: "image fields require template=\"image_caption\"",
      };
    }
    const spec = { kind: "text_surface", body };
    if (typeof obj.title === "string") spec.title = obj.title;
    return { ok: true, spec };
  },
};

const listSurfaceDescriptor = {
  kind: "list_surface",
  itemGrammar: listItemGrammar,
  refreshTargets: ["items"],
  supportsChildren: true,
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
        items: GLASSES_UI_LIST_ITEM_SCHEMA,
      },
      children: GLASSES_UI_CHILDREN_SCHEMA,
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
    const kids = validateChildren(obj, items.length);
    if (!kids.ok) return kids;
    const spec = { kind: "list_surface", items };
    if (typeof obj.title === "string") spec.title = obj.title;
    if (kids.children) spec.children = kids.children;
    return { ok: true, spec };
  },
};

const listWithDetailsSurfaceDescriptor = {
  kind: "list_with_details_surface",
  itemGrammar: detailItemGrammar,
  refreshTargets: ["items"],
  supportsChildren: true,
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
        items: GLASSES_UI_DETAIL_ITEM_SCHEMA,
      },
      children: GLASSES_UI_CHILDREN_SCHEMA,
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
      const unknownKey = Object.keys(it).find(
        (key) => !detailItemGrammar.allowedKeys.includes(key),
      );
      if (unknownKey) {
        return {
          ok: false,
          code: "item_field_unknown",
          message: `items[${i}] has unknown field: ${unknownKey}`,
        };
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
    const kids = validateChildren(obj, normalizedItems.length);
    if (!kids.ok) return kids;
    const spec = { kind: "list_with_details_surface", items: normalizedItems };
    if (typeof obj.title === "string") spec.title = obj.title;
    if (kids.children) spec.children = kids.children;
    return { ok: true, spec };
  },
};

const checklistSurfaceDescriptor = {
  kind: "checklist_surface",
  itemGrammar: checklistItemGrammar,
  refreshTargets: ["items"],
  schemaBranch: {
    title: "checklist_surface",
    type: "object",
    required: ["kind", "items", "queueMode"],
    properties: {
      kind: { const: "checklist_surface" },
      title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
      items: {
        type: "array",
        minItems: 1,
        maxItems: GLASSES_UI_LIMITS.maxItems,
        items: GLASSES_UI_CHECKLIST_ITEM_SCHEMA,
      },
      queueMode: { const: "log" },
      refresh: undefined,
    },
  },
  validateSpec(obj) {
    const titleErr = validateTitle(obj);
    if (titleErr) return titleErr;
    if (obj.queueMode !== "log") {
      return {
        ok: false,
        code: "checklist_queue_mode_required",
        message: 'checklist_surface requires queueMode="log" so the full state survives a closed listen window',
      };
    }
    const items = obj.items;
    if (!Array.isArray(items) || items.length === 0) {
      return { ok: false, code: "missing_field", message: "checklist_surface requires items (non-empty array)" };
    }
    if (items.length > GLASSES_UI_LIMITS.maxItems) {
      return {
        ok: false,
        code: "too_many_items",
        message: `${items.length} items; max ${GLASSES_UI_LIMITS.maxItems}`,
      };
    }
    const normalizedItems = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, code: "missing_field", message: `items[${i}] must be an object {label, checked?}` };
      }
      const extra = Object.keys(item).find(
        (key) => !checklistItemGrammar.allowedKeys.includes(key),
      );
      if (extra) {
        return { ok: false, code: "unknown_field", message: `items[${i}].${extra} is not supported` };
      }
      if (typeof item.label !== "string") {
        return { ok: false, code: "missing_field", message: `items[${i}].label is required` };
      }
      if (item.label.length > GLASSES_UI_LIMITS.itemMax) {
        return {
          ok: false,
          code: "item_too_long",
          message: `items[${i}].label is ${item.label.length} chars; max ${GLASSES_UI_LIMITS.itemMax}`,
        };
      }
      if (item.checked !== undefined && typeof item.checked !== "boolean") {
        return { ok: false, code: "invalid_checked", message: `items[${i}].checked must be a boolean` };
      }
      const normalized = { label: item.label };
      if (item.checked !== undefined) normalized.checked = item.checked;
      normalizedItems.push(normalized);
    }
    const spec = { kind: "checklist_surface", items: normalizedItems };
    if (typeof obj.title === "string") spec.title = obj.title;
    return { ok: true, spec };
  },
};

const pagedTextSurfaceDescriptor = {
  kind: "paged_text_surface",
  itemGrammar: null,
  refreshTargets: [],
  schemaBranch: {
    title: "paged_text_surface",
    type: "object",
    required: ["kind", "pages"],
    properties: {
      kind: { const: "paged_text_surface" },
      title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
      pages: {
        type: "array",
        minItems: 1,
        maxItems: GLASSES_UI_LIMITS.maxPages,
        items: { type: "string", maxLength: GLASSES_UI_LIMITS.pageMax },
      },
      refresh: undefined,
    },
  },
  validateSpec(obj) {
    const titleErr = validateTitle(obj);
    if (titleErr) return titleErr;
    const pages = obj.pages;
    if (!Array.isArray(pages) || pages.length === 0) {
      return { ok: false, code: "missing_field", message: "paged_text_surface requires pages (non-empty array)" };
    }
    if (pages.length > GLASSES_UI_LIMITS.maxPages) {
      return {
        ok: false,
        code: "too_many_pages",
        message: `${pages.length} pages; max ${GLASSES_UI_LIMITS.maxPages}`,
      };
    }
    for (let i = 0; i < pages.length; i += 1) {
      if (typeof pages[i] !== "string") {
        return { ok: false, code: "invalid_page", message: `pages[${i}] must be a string` };
      }
      if (pages[i].length > GLASSES_UI_LIMITS.pageMax) {
        return {
          ok: false,
          code: "page_too_long",
          message: `pages[${i}] is ${pages[i].length} chars; max ${GLASSES_UI_LIMITS.pageMax}`,
        };
      }
    }
    const spec = { kind: "paged_text_surface", pages: [...pages] };
    if (typeof obj.title === "string") spec.title = obj.title;
    return { ok: true, spec };
  },
};

const GLASSES_UI_KIND_DESCRIPTORS = [
  textSurfaceDescriptor,
  listSurfaceDescriptor,
  listWithDetailsSurfaceDescriptor,
  checklistSurfaceDescriptor,
  pagedTextSurfaceDescriptor,
];

function getKindDescriptor(kind) {
  return GLASSES_UI_KIND_DESCRIPTORS.find((d) => d.kind === kind);
}

function getKindItemGrammar(kind) {
  return getKindDescriptor(kind)?.itemGrammar || null;
}

function listKindItemSchemas() {
  return GLASSES_UI_KIND_DESCRIPTORS
    .map((descriptor) => descriptor.itemGrammar?.schema)
    .filter(Boolean);
}

function matchesSchemaType(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  return false;
}

function validateKindItemAgainstGrammar(kind, item) {
  const grammar = getKindItemGrammar(kind);
  if (!grammar) return { ok: false, code: "items_unsupported" };
  if (grammar.valueType !== "object") {
    return matchesSchemaType(item, grammar.valueType)
      ? { ok: true }
      : { ok: false, code: "invalid_item" };
  }
  if (!matchesSchemaType(item, "object")) {
    return { ok: false, code: "invalid_item" };
  }
  const unknown = Object.keys(item).find((key) => !grammar.allowedKeys.includes(key));
  if (unknown) return { ok: false, code: "unknown_field", field: String(unknown) };
  for (const rule of grammar.requiredTypeRules) {
    if (!matchesSchemaType(item[rule.key], rule.type)) {
      return { ok: false, code: "invalid_field", field: rule.key };
    }
  }
  for (const rule of grammar.optionalTypeRules) {
    if (item[rule.key] !== undefined && !matchesSchemaType(item[rule.key], rule.type)) {
      return { ok: false, code: "invalid_field", field: rule.key };
    }
  }
  return { ok: true };
}

function listKindStrings() {
  return GLASSES_UI_KIND_DESCRIPTORS.map((d) => d.kind);
}

function buildOneOfBranches() {
  return GLASSES_UI_KIND_DESCRIPTORS.map((d) => d.schemaBranch);
}

module.exports = { GLASSES_UI_LIST_ITEM_SCHEMA, GLASSES_UI_DETAIL_ITEM_SCHEMA, GLASSES_UI_CHECKLIST_ITEM_SCHEMA, GLASSES_UI_CHILD_KINDS, GLASSES_UI_CHILD_SURFACE_SCHEMA, GLASSES_UI_CHILDREN_SCHEMA, GLASSES_UI_IMAGE_ASSETS, GLASSES_UI_KIND_DESCRIPTORS, getKindDescriptor, getKindItemGrammar, listKindItemSchemas, validateKindItemAgainstGrammar, listKindStrings, buildOneOfBranches };
