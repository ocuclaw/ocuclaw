const { GLASSES_UI_LIMITS } = require("./glasses-ui-limits.cjs");
const { GRAPHIC_ICON_NAMES } = require("./glasses-ui-graphic-icons.cjs");

const GLASSES_UI_IMAGE_ASSETS = ["hermes_welcome"];

const GRAPHIC_SLOT_VALIDATORS = Object.freeze(Object.assign(Object.create(null), {
  metric: validateGraphicMetricSlot,
  sparkline: validateGraphicSparklineSlot,
  bars: validateGraphicBarsSlot,
  heatstrip: validateGraphicHeatstripSlot,
  progress: validateGraphicProgressSlot,
  ring: validateGraphicRingSlot,
  bullet: validateGraphicBulletSlot,
  gauge: validateGraphicGaugeSlot,
  keyvalue: validateGraphicKeyvalueSlot,
  status: validateGraphicStatusSlot,
}));
const GRAPHIC_SLOT_TYPES = Object.freeze(Object.keys(GRAPHIC_SLOT_VALIDATORS));

const GLASSES_UI_GRAPHIC_SCHEMA = {
  type: "object",
  description:
    "Required when template=\"graphic\". One or two typed slots the glasses draw side by side above the body caption; " +
    "never pixels, sizes or coordinates. " +
    "{\"slots\":[{\"type\":\"metric\",\"value\":\"12.5\",\"unit\":\"kt\",\"label\":\"Wind\",\"delta\":1.5}," +
    "{\"type\":\"sparkline\",\"values\":[9,11,10,12.5],\"label\":\"Last hour\"}]}. " +
    "Slightly-wrong slots are repaired (text cut, long series downsampled or trimmed to recent, a percent read as a fraction, values clamped, extra slots or rows dropped, an unknown icon removed); the result lists every repair.",
  required: ["slots"],
  properties: {
    slots: {
      type: "array",
      minItems: 1,
      description: `1-${GLASSES_UI_LIMITS.graphicSlotsMax} slots; more keep the first ${GLASSES_UI_LIMITS.graphicSlotsMax}.`,
      items: {
        type: "object",
        description:
          "One slot. metric: value, unit?, label?, delta?, icon?. sparkline: values, label?. " +
          "bars: values, highlight?, label?. heatstrip: values, label?. " +
          "progress, ring: value, label?. bullet: value, target, max, label?. gauge: value, min?, max?, label?. " +
          "keyvalue: rows, label?. status: text, icon?.",
        required: ["type"],
        properties: {

          type: {
            type: "string",
            enum: [...GRAPHIC_SLOT_TYPES],
            description:
              "Pick by the shape of the reading: one number that matters -> metric; a trend over time -> sparkline; " +
              "a share of a goal -> progress or ring; a value against its target -> bullet; a per-hour pattern -> heatstrip; " +
              "a few facts -> keyvalue; a plain state -> status with an icon; a few values with one that matters -> bars; " +
              "a value on a known scale -> gauge.",
          },
          value: {
            description:
              `metric: the number that matters, as text of 1-${GLASSES_UI_LIMITS.graphicMetricValueMax} chars, e.g. "12.5". ` +
              "progress, ring: a JSON number, the fraction done 0..1 " +
              "(a value above 1 up to 100 is read as a percent). bullet, gauge: the reading as a number.",
          },
          target: { type: "number", description: "bullet: the goal, on the same 0..max scale as value." },
          min: { type: "number", description: `gauge: optional bottom of the scale (default ${GLASSES_UI_LIMITS.graphicGaugeMinDefault}).` },
          max: {
            type: "number",
            description: `bullet: the top of the scale, above 0. gauge: optional top of the scale (default ${GLASSES_UI_LIMITS.graphicGaugeMaxDefault}), above min.`,
          },
          unit: {
            type: "string",
            minLength: 1,
            description: `metric: optional unit up to ${GLASSES_UI_LIMITS.graphicMetricUnitMax} chars (longer is cut), e.g. "kt".`,
          },
          label: {
            type: "string",
            minLength: 1,
            description: `Any slot but status: optional short label up to ${GLASSES_UI_LIMITS.graphicMetricLabelMax} chars (longer is cut), e.g. "Wind".`,
          },
          delta: { type: "number", description: "metric: optional signed change since the last reading." },
          values: {
            type: "array",
            minItems: GLASSES_UI_LIMITS.graphicSeriesMin,
            items: { type: "number" },
            description:
              `sparkline, bars, heatstrip: the series as numbers, oldest first. sparkline up to ${GLASSES_UI_LIMITS.graphicSparklineValuesMax} ` +
              `(more are downsampled); bars up to ${GLASSES_UI_LIMITS.graphicBarsValuesMax} and heatstrip up to ` +
              `${GLASSES_UI_LIMITS.graphicHeatstripValuesMax} (more keep the most recent). heatstrip values are 0..1.`,
          },
          highlight: { type: "integer", minimum: 0, description: "bars: optional index into values of the one bar to fill." },
          rows: {
            type: "array",
            minItems: 1,
            items: { type: "array" },
            description:
              `keyvalue: 1-${GLASSES_UI_LIMITS.graphicKeyvalueRowsMax} [key, value] text pairs, e.g. [["Gust","18 kt"],["Tide","High"]]. ` +
              `Keys up to ${GLASSES_UI_LIMITS.graphicKeyvalueKeyMax} chars, values up to ${GLASSES_UI_LIMITS.graphicKeyvalueValueMax} ` +
              `(longer is cut); more rows keep the first ${GLASSES_UI_LIMITS.graphicKeyvalueRowsMax}.`,
          },
          text: {
            type: "string",
            description: `status: the state in words, up to ${GLASSES_UI_LIMITS.graphicStatusTextMax} chars (longer is cut), e.g. "Rain in 20 min".`,
          },
          icon: {
            type: "string",
            description:
              "metric, status: optional icon name, e.g. \"sun\", \"cloud-rain\", \"wind\", \"battery-low\", \"alert-triangle\", \"check-circle\". " +
              "Only the names in the glasses-ui skill's references/graphic-icons.md draw; any other name is removed, never guessed.",
          },
        },
      },
    },
  },
};

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
        ...(typeof obj.title === "string" ? { title: obj.title } : {}),
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
      ...(typeof obj.title === "string" ? { title: obj.title } : {}),
      body,
      imageBase64: obj.imageBase64,
      imageWidth,
      imageHeight,
    },
  };
}

const GRAPHIC_FIELDS = Object.freeze(["slots"]);
const GRAPHIC_METRIC_FIELDS = Object.freeze(["type", "value", "unit", "label", "delta", "icon"]);
const GRAPHIC_SPARKLINE_FIELDS = Object.freeze(["type", "values", "label"]);
const GRAPHIC_BARS_FIELDS = Object.freeze(["type", "values", "highlight", "label"]);
const GRAPHIC_HEATSTRIP_FIELDS = Object.freeze(["type", "values", "label"]);

const GRAPHIC_HEATSTRIP_MIN = 0;
const GRAPHIC_HEATSTRIP_MAX = 1;

const GRAPHIC_ELLIPSIS = "…";

const GRAPHIC_SLOT_TYPE_ECHO_MAX = 40;

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function graphicSlotDataInvalid(path = "", detail = "") {
  return { ok: false, code: "graphic_slot_data_invalid", message: `${path} ${detail}` };
}

function createRepairCollector() {
  const repairs = [];
  return {
    push(code, path, message) {
      repairs.push({ code, path, message });
    },
    list() {
      return repairs.map((repair) => ({ ...repair }));
    },
  };
}

function osaDistance(a, b) {
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = best;
    }
  }
  return rows[a.length][b.length];
}

function nearestName(input, candidates) {
  const names = (Array.isArray(candidates) ? candidates : [])
    .filter((name) => typeof name === "string")
    .sort();
  if (names.length === 0) return null;
  const fold = (value) =>
    String(value).slice(0, GRAPHIC_SLOT_TYPE_ECHO_MAX).toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = typeof input === "string" ? fold(input) : "";
  const exact = names.find((name) => fold(name) === wanted);
  if (exact !== undefined) return exact;
  if (wanted.length >= 3) {
    let prefixMatch = null;
    let prefixGap = Infinity;
    for (const name of names) {
      const folded = fold(name);
      if (!folded.startsWith(wanted) && !wanted.startsWith(folded)) continue;
      const gap = Math.abs(folded.length - wanted.length);
      if (gap < prefixGap) {
        prefixMatch = name;
        prefixGap = gap;
      }
    }
    if (prefixMatch !== null) return prefixMatch;
  }
  let nearest = names[0];
  let nearestDistance = Infinity;
  for (const name of names) {
    const distance = osaDistance(wanted, fold(name));
    if (distance < nearestDistance) {
      nearest = name;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function graphicSlotTypeUnknown(fieldPath, type) {
  const got = typeof type === "string"
    ? JSON.stringify(type.slice(0, GRAPHIC_SLOT_TYPE_ECHO_MAX))
    : "a missing or non-string type";
  return {
    ok: false,
    code: "graphic_slot_type_unknown",
    message:
      `${fieldPath} ${got} is not a Graphic slot type; allowed: ${GRAPHIC_SLOT_TYPES.join(", ")}; ` +
      `nearest: ${nearestName(type, GRAPHIC_SLOT_TYPES)}`,
  };
}

function truncateGraphicText(text, max) {
  let kept = "";
  for (const ch of text) {
    if (kept.length + ch.length > max - GRAPHIC_ELLIPSIS.length) break;
    kept += ch;
  }
  return kept.trimEnd() + GRAPHIC_ELLIPSIS;
}

function readGraphicText(slot, key, max, path, repairs, hint = "") {
  return readGraphicTextAt(slot[key], `${path}.${key}`, max, repairs, hint);
}

function readGraphicTextAt(value, fieldPath, max, repairs, hint = "") {
  if (typeof value !== "string" || value.trim().length === 0) {
    return graphicSlotDataInvalid(fieldPath, `must be a non-blank string of 1-${max} chars${hint}`);
  }
  if (value.length <= max) return { ok: true, value };
  const cut = truncateGraphicText(value, max);
  repairs.push(
    "text_truncated",
    fieldPath,
    `${fieldPath} was ${value.length} chars; cut to ${cut.length} with an ellipsis (max ${max})`,
  );
  return { ok: true, value: cut };
}

function validateGraphicMetricSlot(slot, path, repairs) {
  const unknown = Object.keys(slot).find((key) => !GRAPHIC_METRIC_FIELDS.includes(key));
  if (unknown !== undefined) {
    return graphicSlotDataInvalid(
      `${path}.${unknown}`,
      `is not a metric field; allowed: ${GRAPHIC_METRIC_FIELDS.join(", ")}`,
    );
  }
  const value = readGraphicText(slot, "value", GLASSES_UI_LIMITS.graphicMetricValueMax, path, repairs, ', e.g. "12.5"');
  if (!value.ok) return value;
  const unit = slot.unit === undefined
    ? { ok: true, value: undefined }
    : readGraphicText(slot, "unit", GLASSES_UI_LIMITS.graphicMetricUnitMax, path, repairs);
  if (!unit.ok) return unit;
  const label = slot.label === undefined
    ? { ok: true, value: undefined }
    : readGraphicText(slot, "label", GLASSES_UI_LIMITS.graphicMetricLabelMax, path, repairs);
  if (!label.ok) return label;
  if (slot.delta !== undefined && (typeof slot.delta !== "number" || !Number.isFinite(slot.delta))) {
    return graphicSlotDataInvalid(`${path}.delta`, "must be a finite number, e.g. 1.5 or -2");
  }
  const icon = readOptionalGraphicIcon(slot, path, repairs);
  if (!icon.ok) return icon;

  const normalized = { type: "metric", value: value.value };
  if (unit.value !== undefined) normalized.unit = unit.value;
  if (label.value !== undefined) normalized.label = label.value;
  if (slot.delta !== undefined) normalized.delta = slot.delta;
  if (icon.value !== undefined) normalized.icon = icon.value;
  return { ok: true, slot: normalized };
}

const GRAPHIC_ICON_SET = Object.freeze(Object.assign(
  Object.create(null),
  Object.fromEntries(GRAPHIC_ICON_NAMES.map((name) => [name, true])),
));

const GRAPHIC_ICON_ECHO_MAX = 40;
const GRAPHIC_KEYVALUE_FIELDS = Object.freeze(["type", "rows", "label"]);
const GRAPHIC_STATUS_FIELDS = Object.freeze(["type", "text", "icon"]);

function readOptionalGraphicIcon(slot, path, repairs) {
  const icon = slot.icon;
  if (icon === undefined) return { ok: true, value: undefined };
  const fieldPath = `${path}.icon`;
  if (typeof icon !== "string") {
    return graphicSlotDataInvalid(fieldPath, 'must be an icon name as a string, e.g. "wind"');
  }
  if (GRAPHIC_ICON_SET[icon] === true) return { ok: true, value: icon };
  repairs.push(
    "icon_dropped",
    fieldPath,
    `${fieldPath} ${JSON.stringify(icon.slice(0, GRAPHIC_ICON_ECHO_MAX))} is not a Graphic icon name; removed ` +
      "(icons are never guessed; the names are in the glasses-ui skill's references/graphic-icons.md)",
  );
  return { ok: true, value: undefined };
}

function readGraphicKeyvalueCell(row, index, max, rowPath, repairs) {
  const raw = row[index];
  const cell = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  const role = index === 0 ? "the key" : "the value";
  return readGraphicTextAt(cell, `${rowPath}[${index}]`, max, repairs, ` (${role})`);
}

function validateGraphicKeyvalueSlot(slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_KEYVALUE_FIELDS, "keyvalue", path);
  if (unknown) return unknown;
  const fieldPath = `${path}.rows`;
  const rowsMax = GLASSES_UI_LIMITS.graphicKeyvalueRowsMax;
  if (!Array.isArray(slot.rows) || slot.rows.length === 0) {
    return graphicSlotDataInvalid(
      fieldPath,
      `must be an array of 1-${rowsMax} [key, value] rows, e.g. [["Gust", "18 kt"], ["Tide", "High"]]`,
    );
  }
  let rawRows = slot.rows;
  if (rawRows.length > rowsMax) {
    repairs.push(
      "rows_trimmed",
      fieldPath,
      `${fieldPath} held ${rawRows.length} rows; kept the first ${rowsMax} (max ${rowsMax})`,
    );
    rawRows = rawRows.slice(0, rowsMax);
  }
  const rows = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    const row = rawRows[index];
    const rowPath = `${fieldPath}[${index}]`;
    if (!Array.isArray(row) || row.length !== 2) {
      return graphicSlotDataInvalid(rowPath, 'must be a [key, value] pair of two strings, e.g. ["Gust", "18 kt"]');
    }
    const key = readGraphicKeyvalueCell(row, 0, GLASSES_UI_LIMITS.graphicKeyvalueKeyMax, rowPath, repairs);
    if (!key.ok) return key;
    const value = readGraphicKeyvalueCell(row, 1, GLASSES_UI_LIMITS.graphicKeyvalueValueMax, rowPath, repairs);
    if (!value.ok) return value;
    rows.push([key.value, value.value]);
  }
  const label = readOptionalGraphicLabel(slot, path, repairs);
  if (!label.ok) return label;
  const normalized = { type: "keyvalue", rows };
  if (label.value !== undefined) normalized.label = label.value;
  return { ok: true, slot: normalized };
}

function validateGraphicStatusSlot(slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_STATUS_FIELDS, "status", path);
  if (unknown) return unknown;
  const text = readGraphicText(slot, "text", GLASSES_UI_LIMITS.graphicStatusTextMax, path, repairs, ', e.g. "Rain in 20 min"');
  if (!text.ok) return text;
  const icon = readOptionalGraphicIcon(slot, path, repairs);
  if (!icon.ok) return icon;
  const normalized = { type: "status", text: text.value };
  if (icon.value !== undefined) normalized.icon = icon.value;
  return { ok: true, slot: normalized };
}

function graphicUnknownSlotField(slot, fields, type, path) {
  const unknown = Object.keys(slot).find((key) => !fields.includes(key));
  if (unknown === undefined) return null;
  return graphicSlotDataInvalid(`${path}.${unknown}`, `is not a ${type} field; allowed: ${fields.join(", ")}`);
}

function readOptionalGraphicLabel(slot, path, repairs) {
  if (slot.label === undefined) return { ok: true, value: undefined };
  return readGraphicText(slot, "label", GLASSES_UI_LIMITS.graphicMetricLabelMax, path, repairs);
}

function readGraphicSeries(slot, path) {
  const values = slot.values;
  const fieldPath = `${path}.values`;
  const min = GLASSES_UI_LIMITS.graphicSeriesMin;
  if (!Array.isArray(values)) {
    return graphicSlotDataInvalid(fieldPath, `must be an array of at least ${min} numbers, oldest first, e.g. [9, 11, 10, 12.5]`);
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return graphicSlotDataInvalid(`${fieldPath}[${index}]`, "must be a finite number, not text or null");
    }
  }
  if (values.length < min) {
    return graphicSlotDataInvalid(fieldPath, `has ${values.length} number(s); a trend needs at least ${min}`);
  }
  return { ok: true, values: values.slice() };
}

function downsampleGraphicSeries(values, target) {
  const count = values.length;
  if (count <= target || target < 3) return values.slice();
  const every = (count - 2) / (target - 2);
  const kept = [values[0]];
  let previous = 0;
  for (let bucket = 0; bucket < target - 2; bucket += 1) {
    const nextStart = Math.floor((bucket + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((bucket + 2) * every) + 1, count);
    let averageX = 0;
    let averageY = 0;
    for (let index = nextStart; index < nextEnd; index += 1) {
      averageX += index;
      averageY += values[index];
    }
    const nextLength = nextEnd - nextStart;
    averageX /= nextLength;
    averageY /= nextLength;
    const start = Math.floor(bucket * every) + 1;
    const end = Math.floor((bucket + 1) * every) + 1;
    const previousY = values[previous];
    let bestArea = -1;
    let best = start;
    for (let index = start; index < end; index += 1) {
      const area = Math.abs(
        (previous - averageX) * (values[index] - previousY) - (previous - index) * (averageY - previousY),
      );
      if (area > bestArea) {
        bestArea = area;
        best = index;
      }
    }
    kept.push(values[best]);
    previous = best;
  }
  kept.push(values[count - 1]);
  return kept;
}

function clampGraphicValue(value, min, max, path, repairs) {
  if (value >= min && value <= max) return value;
  const kept = value < min ? min : max;
  repairs.push("value_clamped", path, `${path} was ${value}; clamped to ${kept} (range ${min}..${max})`);
  return kept;
}

function clampGraphicSeries(values, min, max, path, repairs) {
  const outside = [];
  const kept = values.map((value, index) => {
    if (value >= min && value <= max) return value;
    outside.push(index);
    return value < min ? min : max;
  });
  if (outside.length > 0) {
    repairs.push(
      "value_clamped",
      path,
      `${path} held ${outside.length} value(s) outside ${min}..${max} (index ${outside.join(", ")}); clamped each into ${min}..${max}`,
    );
  }
  return kept;
}

function trimGraphicSeriesToRecent(values, max) {
  return values.length > max ? values.slice(values.length - max) : values;
}

function validateGraphicSparklineSlot(slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_SPARKLINE_FIELDS, "sparkline", path);
  if (unknown) return unknown;
  const series = readGraphicSeries(slot, path);
  if (!series.ok) return series;
  const max = GLASSES_UI_LIMITS.graphicSparklineValuesMax;
  let values = series.values;
  if (values.length > max) {
    values = downsampleGraphicSeries(values, max);
    repairs.push(
      "series_downsampled",
      `${path}.values`,
      `${path}.values held ${series.values.length} points; downsampled to ${max} (max ${max}), ` +
        "keeping the first and last points; every kept point is one you sent",
    );
  }
  const label = readOptionalGraphicLabel(slot, path, repairs);
  if (!label.ok) return label;
  const normalized = { type: "sparkline", values };
  if (label.value !== undefined) normalized.label = label.value;
  return { ok: true, slot: normalized };
}

function validateGraphicBarsSlot(slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_BARS_FIELDS, "bars", path);
  if (unknown) return unknown;
  const series = readGraphicSeries(slot, path);
  if (!series.ok) return series;
  const count = series.values.length;
  const highlight = slot.highlight;
  if (highlight !== undefined && (!Number.isInteger(highlight) || highlight < 0 || highlight >= count)) {
    return graphicSlotDataInvalid(`${path}.highlight`, `must be an integer index into values, 0-${count - 1}`);
  }
  const max = GLASSES_UI_LIMITS.graphicBarsValuesMax;
  const values = trimGraphicSeriesToRecent(series.values, max);
  let keptHighlight = highlight === undefined ? undefined : highlight + 0;
  if (values.length < count) {
    const dropped = count - values.length;
    let note = "";
    if (highlight !== undefined && highlight < dropped) {
      keptHighlight = undefined;
      note = `; the highlighted bar (index ${highlight}) was one of the dropped, so highlight was removed`;
    } else if (highlight !== undefined) {
      keptHighlight = highlight - dropped;
      note = `; highlight moved from index ${highlight} to ${keptHighlight}, the same bar`;
    }
    repairs.push(
      "series_trimmed_to_recent",
      `${path}.values`,
      `${path}.values held ${count} values; kept the most recent ${max} (max ${max})${note}`,
    );
  }
  const label = readOptionalGraphicLabel(slot, path, repairs);
  if (!label.ok) return label;
  const normalized = { type: "bars", values };
  if (keptHighlight !== undefined) normalized.highlight = keptHighlight;
  if (label.value !== undefined) normalized.label = label.value;
  return { ok: true, slot: normalized };
}

function validateGraphicHeatstripSlot(slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_HEATSTRIP_FIELDS, "heatstrip", path);
  if (unknown) return unknown;
  const series = readGraphicSeries(slot, path);
  if (!series.ok) return series;
  const max = GLASSES_UI_LIMITS.graphicHeatstripValuesMax;
  const recent = trimGraphicSeriesToRecent(series.values, max);
  if (recent.length < series.values.length) {
    repairs.push(
      "series_trimmed_to_recent",
      `${path}.values`,
      `${path}.values held ${series.values.length} values; kept the most recent ${max} (max ${max})`,
    );
  }

  const values = clampGraphicSeries(recent, GRAPHIC_HEATSTRIP_MIN, GRAPHIC_HEATSTRIP_MAX, `${path}.values`, repairs);
  const label = readOptionalGraphicLabel(slot, path, repairs);
  if (!label.ok) return label;
  const normalized = { type: "heatstrip", values };
  if (label.value !== undefined) normalized.label = label.value;
  return { ok: true, slot: normalized };
}

const GRAPHIC_FRACTION_FIELDS = Object.freeze(["type", "value", "label"]);
const GRAPHIC_BULLET_FIELDS = Object.freeze(["type", "value", "target", "max", "label"]);
const GRAPHIC_GAUGE_FIELDS = Object.freeze(["type", "value", "min", "max", "label"]);

const GRAPHIC_PERCENT_READ_MAX = 100;

function readGraphicNumber(slot, key, path, hint = "") {
  const value = slot[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return graphicSlotDataInvalid(`${path}.${key}`, `must be a finite number${hint}, not text or null`);
  }
  return { ok: true, value: value + 0 };
}

function readOptionalGraphicNumber(slot, key, path, hint = "") {
  if (slot[key] === undefined) return { ok: true, value: undefined };
  return readGraphicNumber(slot, key, path, hint);
}

function validateGraphicFractionSlot(type, slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_FRACTION_FIELDS, type, path);
  if (unknown) return unknown;
  const read = readGraphicNumber(slot, "value", path, ", the fraction done 0..1 such as 0.68");
  if (!read.ok) return read;
  const fieldPath = `${path}.value`;
  let value = read.value;
  if (value > 1 && value <= GRAPHIC_PERCENT_READ_MAX) {
    const fraction = value / GRAPHIC_PERCENT_READ_MAX;
    repairs.push(
      "percent_read_as_fraction",
      fieldPath,
      `${fieldPath} was ${value}; read as a percent and divided by 100 to ${fraction} (value is a fraction 0..1)`,
    );
    value = fraction;
  } else {
    value = clampGraphicValue(value, 0, 1, fieldPath, repairs);
  }
  const label = readOptionalGraphicLabel(slot, path, repairs);
  if (!label.ok) return label;
  const normalized = { type, value };
  if (label.value !== undefined) normalized.label = label.value;
  return { ok: true, slot: normalized };
}

function validateGraphicProgressSlot(slot, path, repairs) {
  return validateGraphicFractionSlot("progress", slot, path, repairs);
}

function validateGraphicRingSlot(slot, path, repairs) {
  return validateGraphicFractionSlot("ring", slot, path, repairs);
}

function validateGraphicBulletSlot(slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_BULLET_FIELDS, "bullet", path);
  if (unknown) return unknown;
  const value = readGraphicNumber(slot, "value", path);
  if (!value.ok) return value;
  const target = readGraphicNumber(slot, "target", path, ", the goal on the same scale as value");
  if (!target.ok) return target;
  const max = readGraphicNumber(slot, "max", path, ", the top of the scale above 0");
  if (!max.ok) return max;
  if (max.value <= 0) {
    return graphicSlotDataInvalid(`${path}.max`, `must be above 0; got ${max.value}`);
  }
  const keptValue = clampGraphicValue(value.value, 0, max.value, `${path}.value`, repairs);
  const keptTarget = clampGraphicValue(target.value, 0, max.value, `${path}.target`, repairs);
  const label = readOptionalGraphicLabel(slot, path, repairs);
  if (!label.ok) return label;
  const normalized = { type: "bullet", value: keptValue, target: keptTarget, max: max.value };
  if (label.value !== undefined) normalized.label = label.value;
  return { ok: true, slot: normalized };
}

function validateGraphicGaugeSlot(slot, path, repairs) {
  const unknown = graphicUnknownSlotField(slot, GRAPHIC_GAUGE_FIELDS, "gauge", path);
  if (unknown) return unknown;
  const value = readGraphicNumber(slot, "value", path);
  if (!value.ok) return value;
  const min = readOptionalGraphicNumber(slot, "min", path);
  if (!min.ok) return min;
  const max = readOptionalGraphicNumber(slot, "max", path);
  if (!max.ok) return max;
  const low = min.value === undefined ? GLASSES_UI_LIMITS.graphicGaugeMinDefault : min.value;
  const high = max.value === undefined ? GLASSES_UI_LIMITS.graphicGaugeMaxDefault : max.value;
  if (high <= low) {
    const highText = max.value === undefined ? `${high} (the default)` : `${high}`;
    const lowText = min.value === undefined ? `${low} (the default)` : `${low}`;
    return graphicSlotDataInvalid(`${path}.max`, `must be above min; got max ${highText} and min ${lowText}`);
  }
  const kept = clampGraphicValue(value.value, low, high, `${path}.value`, repairs);
  const label = readOptionalGraphicLabel(slot, path, repairs);
  if (!label.ok) return label;
  const normalized = { type: "gauge", value: kept };
  if (min.value !== undefined) normalized.min = min.value;
  if (max.value !== undefined) normalized.max = max.value;
  if (label.value !== undefined) normalized.label = label.value;
  return { ok: true, slot: normalized };
}

function validateGraphicTemplate(obj = Object.create(null), body = "") {
  if (obj.title !== undefined) {
    return {
      ok: false,
      code: "graphic_title_unsupported",
      message: "graphic has no title; put what the reading is in the caption body, numbers first",
    };
  }
  if (obj.refresh !== undefined) {
    return {
      ok: false,
      code: "graphic_refresh_unsupported",
      message: "graphic does not support refresh; re-render with update:\"patch\" to change it",
    };
  }
  if (body.trim().length === 0 || body.length > GLASSES_UI_LIMITS.graphicCaptionMax) {
    return {
      ok: false,
      code: "graphic_body_required",
      message: `graphic requires body, a 1-${GLASSES_UI_LIMITS.graphicCaptionMax} char caption that is also the fallback text`,
    };
  }
  if (
    obj.imageAsset !== undefined || obj.imageBase64 !== undefined ||
    obj.imageWidth !== undefined || obj.imageHeight !== undefined
  ) {
    return {
      ok: false,
      code: "image_template_required",
      message: "image fields require template=\"image_caption\"; a graphic is drawn from graphic.slots",
    };
  }
  const graphic = obj.graphic;
  const example = '{"slots":[{"type":"metric","value":"12.5","unit":"kt","label":"Wind"}]}';
  if (!isPlainRecord(graphic) || !Array.isArray(graphic.slots) || graphic.slots.length === 0) {
    return {
      ok: false,
      code: "graphic_slots_missing",
      message: `graphic requires graphic.slots with at least one slot, e.g. ${example}`,
    };
  }
  const unknownField = Object.keys(graphic).find((key) => !GRAPHIC_FIELDS.includes(key));
  if (unknownField !== undefined) {
    return graphicSlotDataInvalid(`graphic.${unknownField}`, "is not a graphic field; allowed: slots");
  }
  const repairs = createRepairCollector();
  const slotsMax = GLASSES_UI_LIMITS.graphicSlotsMax;
  let rawSlots = graphic.slots;
  if (rawSlots.length > slotsMax) {

    repairs.push(
      "slots_trimmed",
      "graphic.slots",
      `graphic.slots held ${rawSlots.length} slots; kept the first ${slotsMax} (max ${slotsMax})`,
    );
    rawSlots = rawSlots.slice(0, slotsMax);
  }
  const slots = [];
  for (let index = 0; index < rawSlots.length; index += 1) {
    const slot = rawSlots[index];
    const path = `graphic.slots[${index}]`;
    if (!isPlainRecord(slot)) {
      return graphicSlotDataInvalid(path, `must be a slot object, e.g. ${example}`);
    }
    const validate = typeof slot.type === "string" ? GRAPHIC_SLOT_VALIDATORS[slot.type] : undefined;
    if (typeof validate !== "function") return graphicSlotTypeUnknown(`${path}.type`, slot.type);
    const result = validate(slot, path, repairs);
    if (!result.ok) return result;
    slots.push(result.slot);
  }
  const repaired = repairs.list();
  return {
    ok: true,
    spec: { kind: "text_surface", template: "graphic", body, graphic: { slots } },
    ...(repaired.length > 0 ? { repairs: repaired } : {}),
  };
}

const TEXT_SURFACE_TEMPLATE_VALIDATORS = Object.assign(Object.create(null), {
  image_caption: validateImageCaptionTemplate,
  graphic: validateGraphicTemplate,
});

function textSurfaceTemplateValues() {
  return Object.keys(TEXT_SURFACE_TEMPLATE_VALIDATORS);
}

function validateTextSurfaceTemplate(obj = Object.create(null), body = "") {
  const template = obj.template;
  const validate = typeof template === "string" ? TEXT_SURFACE_TEMPLATE_VALIDATORS[template] : undefined;
  if (typeof validate !== "function") {
    const registered = textSurfaceTemplateValues().map((value) => JSON.stringify(value)).join(", ");
    return {
      ok: false,
      code: "invalid_template",
      message: `text_surface template must be one of: ${registered}; got ${JSON.stringify(template)}`,
    };
  }
  return validate(obj, body);
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
      template: { type: "string", enum: textSurfaceTemplateValues() },
      imageAsset: { type: "string", enum: GLASSES_UI_IMAGE_ASSETS },
      imageBase64: { type: "string", maxLength: GLASSES_UI_LIMITS.imagePayloadBase64Max },
      imageWidth: { type: "integer", minimum: GLASSES_UI_LIMITS.imageWidthMin, maximum: GLASSES_UI_LIMITS.imageWidthMax },
      imageHeight: { type: "integer", minimum: GLASSES_UI_LIMITS.imageHeightMin, maximum: GLASSES_UI_LIMITS.imageHeightMax },
      graphic: GLASSES_UI_GRAPHIC_SCHEMA,
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
      return validateTextSurfaceTemplate(obj, body);
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
    if (obj.graphic !== undefined) {
      return {
        ok: false,
        code: "invalid_template",
        message: "graphic requires template=\"graphic\"",
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

module.exports = { GLASSES_UI_LIST_ITEM_SCHEMA, GLASSES_UI_DETAIL_ITEM_SCHEMA, GLASSES_UI_CHECKLIST_ITEM_SCHEMA, GLASSES_UI_CHILD_KINDS, GLASSES_UI_CHILD_SURFACE_SCHEMA, GLASSES_UI_CHILDREN_SCHEMA, GLASSES_UI_IMAGE_ASSETS, GLASSES_UI_GRAPHIC_SCHEMA, createRepairCollector, nearestName, downsampleGraphicSeries, GLASSES_UI_KIND_DESCRIPTORS, getKindDescriptor, getKindItemGrammar, listKindItemSchemas, validateKindItemAgainstGrammar, listKindStrings, buildOneOfBranches };
