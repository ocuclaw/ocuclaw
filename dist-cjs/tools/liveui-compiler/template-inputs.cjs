const { classifyPictureSource, PICTURE_DATA_SOURCE_MAX_CHARS } = require("../liveui-pictures/picture-source.cjs");

const LIVEUI_INPUT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

const LIVEUI_INPUTS_MAX = 16;

const LIVEUI_ERROR_INPUT_MAX_BYTES = 100;

const RESERVED_KEY = "error";
const INPUT_TYPES = new Set(["number", "text", "bool", "list", "image"]);
const LIST_SCALAR_TYPES = new Set(["number", "text", "bool"]);
const ROW_FIELD_TYPES = new Set(["number", "text", "bool", "image"]);
const LABEL_MAX_CHARS = 64;
const TEXT_MAX_BYTES = 999;
const LIST_MAX_ITEMS = 20;
const ROW_FIELDS_MAX = 16;

function isPlainObject(value         )                                   {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function own(obj                         , key        )          {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function refuse(code        , message        )                         {
  return { ok: false, code, message };
}

function boundedInt(value         , min        , max        )          {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function validateLiveUiInputs(raw         )                         {
  if (!Array.isArray(raw)) return refuse("inputs_invalid", "inputs must be a list of {key, type} entries");
  if (raw.length > LIVEUI_INPUTS_MAX) {
    return refuse("inputs_too_many", `at most ${LIVEUI_INPUTS_MAX} inputs, got ${raw.length}`);
  }
  const seen = new Set        ();
  const inputs                        = [];
  for (let i = 0; i < raw.length; i += 1) {
    const entry = raw[i];
    if (!isPlainObject(entry)) return refuse("inputs_invalid", `inputs[${i}] must be an object`);
    const key = entry.key;
    if (typeof key !== "string" || !LIVEUI_INPUT_KEY_RE.test(key)) {
      return refuse("input_key_invalid", `inputs[${i}].key must match ${LIVEUI_INPUT_KEY_RE.source}`);
    }
    if (key === RESERVED_KEY) {
      return refuse("input_key_reserved", "error is reserved: every composed surface already has it (T6)");
    }
    if (seen.has(key)) return refuse("input_key_duplicate", `input ${key} is declared twice`);
    seen.add(key);
    const type = entry.type;
    if (typeof type !== "string" || !INPUT_TYPES.has(type)) {
      return refuse("input_type_invalid", `input ${key}: type must be number, text, bool, list or image`);
    }
    const input                      = { key, type: type                    };
    if (own(entry, "label") && entry.label !== undefined) {
      if (typeof entry.label !== "string" || entry.label.length > LABEL_MAX_CHARS) {
        return refuse("inputs_invalid", `input ${key}: label must be text of at most ${LABEL_MAX_CHARS} characters`);
      }
      input.label = entry.label;
    }
    if (own(entry, "required") && entry.required !== undefined) {
      if (typeof entry.required !== "boolean") return refuse("inputs_invalid", `input ${key}: required must be true or false`);
      input.required = entry.required;
    }
    if (type === "number") {
      for (const bound of ["min", "max"]         ) {
        if (entry[bound] === undefined) continue;
        if (typeof entry[bound] !== "number" || !Number.isFinite(entry[bound])) {
          return refuse("inputs_invalid", `input ${key}: ${bound} must be a number`);
        }
        input[bound] = entry[bound]          ;
      }
      if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
        return refuse("inputs_invalid", `input ${key}: min is above max`);
      }
    } else if (type === "text") {
      if (entry.maxBytes !== undefined) {
        if (!boundedInt(entry.maxBytes, 1, TEXT_MAX_BYTES)) {
          return refuse("inputs_invalid", `input ${key}: maxBytes must be a whole number from 1 to ${TEXT_MAX_BYTES}`);
        }
        input.maxBytes = entry.maxBytes          ;
      }
    } else if (type === "list") {
      if (entry.maxItems !== undefined) {
        if (!boundedInt(entry.maxItems, 1, LIST_MAX_ITEMS)) {
          return refuse("inputs_invalid", `input ${key}: maxItems must be a whole number from 1 to ${LIST_MAX_ITEMS}`);
        }
        input.maxItems = entry.maxItems          ;
      }
      const hasOf = entry.of !== undefined;
      const hasFields = entry.fields !== undefined;
      if (hasOf && hasFields) return refuse("inputs_invalid", `input ${key}: a list takes of or fields, not both`);
      if (hasOf) {
        if (typeof entry.of !== "string" || !LIST_SCALAR_TYPES.has(entry.of)) {
          return refuse("input_type_invalid", `input ${key}: of must be number, text or bool`);
        }
        input.of = entry.of                        ;
      }
      if (hasFields) {
        if (!isPlainObject(entry.fields)) return refuse("inputs_invalid", `input ${key}: fields must name each row field's type`);
        const names = Object.keys(entry.fields);
        if (names.length === 0 || names.length > ROW_FIELDS_MAX) {
          return refuse("inputs_invalid", `input ${key}: fields names 1 to ${ROW_FIELDS_MAX} row fields`);
        }
        const fields                                     = {};
        for (const name of names) {
          if (!LIVEUI_INPUT_KEY_RE.test(name)) {
            return refuse("inputs_invalid", `input ${key}: row field ${JSON.stringify(name)} must match ${LIVEUI_INPUT_KEY_RE.source}`);
          }
          const fieldType = entry.fields[name];
          if (typeof fieldType !== "string" || !ROW_FIELD_TYPES.has(fieldType)) {
            return refuse("input_type_invalid", `input ${key}: row field ${name} must be number, text, bool or image`);
          }
          fields[name] = fieldType                      ;
        }
        input.fields = fields;
      }
    }
    inputs.push(input);
  }
  return { ok: true, inputs };
}

const UTF8 = new TextEncoder();

function utf8Bytes(text        )         {
  return UTF8.encode(text).length;
}

function checkScalar(type        , value         , where        , maxBytes        , rules                          = {})              {
  if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, code: "input_value_type", detail: `${where} is not a number` };
    return { ok: true, value };
  }
  if (type === "text") {
    if (typeof value !== "string") return { ok: false, code: "input_value_type", detail: `${where} is not text` };
    if (utf8Bytes(value) > maxBytes) return { ok: false, code: "input_value_bounds", detail: `${where} is over ${maxBytes} bytes` };
    return { ok: true, value };
  }
  if (type === "bool") {
    if (typeof value !== "boolean") return { ok: false, code: "input_value_type", detail: `${where} is not true or false` };
    return { ok: true, value };
  }

  if (typeof value !== "string") return { ok: false, code: "input_value_type", detail: `${where} is not a picture source` };
  const source = classifyPictureSource(value);
  if (source.kind === "url") return { ok: true, value };
  if (source.kind === "bytes") {

    if (value.trim().length - value.trim().indexOf(",") - 1 > PICTURE_DATA_SOURCE_MAX_CHARS) {
      return { ok: false, code: "picture_too_large", detail: `${where} holds over ${PICTURE_DATA_SOURCE_MAX_CHARS} base64 characters` };
    }
    return { ok: true, value };
  }
  if (source.kind === "file") {
    if (rules.files === true) return { ok: true, value };
    return { ok: false, code: "picture_source_refused", detail: `${where} names a file` };
  }
  if (source.kind === "asset" && rules.assets === true) return { ok: true, value };
  return { ok: false, code: "input_value_type", detail: `${where} is not a web address or data: picture` };
}

function checkLiveUiInputValue(
  input                     ,
  value         ,
  rules                          = {},
)                        {
  if (value === null) return { ok: true, value: null };
  const key = input && typeof input.key === "string" ? input.key : "input";
  if (value === undefined) return { ok: false, code: "input_value_type", detail: `${key} has no value` };
  const type = input && input.type;
  if (type === "number") {
    const checked = checkScalar("number", value, key, TEXT_MAX_BYTES);
    if (!checked.ok) return checked;
    if ((input.min !== undefined && (value          ) < input.min) || (input.max !== undefined && (value          ) > input.max)) {
      return { ok: false, code: "input_value_bounds", detail: `${key} is outside ${input.min ?? "-inf"}..${input.max ?? "inf"}` };
    }
    return checked;
  }
  if (type === "text") return checkScalar("text", value, key, input.maxBytes ?? TEXT_MAX_BYTES);
  if (type === "bool" || type === "image") return checkScalar(type, value, key, TEXT_MAX_BYTES, rules);
  if (type === "list") {
    if (!Array.isArray(value)) return { ok: false, code: "input_value_type", detail: `${key} is not a list` };
    const maxItems = input.maxItems ?? LIST_MAX_ITEMS;
    if (value.length > maxItems) return { ok: false, code: "input_value_bounds", detail: `${key} has ${value.length} entries, over ${maxItems}` };
    if (input.fields) {
      const rows                            = [];
      for (let i = 0; i < value.length; i += 1) {
        const row = value[i];
        if (!isPlainObject(row)) return { ok: false, code: "input_value_type", detail: `${key}[${i}] is not a row` };
        const kept                          = {};
        for (const [name, fieldType] of Object.entries(input.fields)) {
          if (!own(row, name) || row[name] === null || row[name] === undefined) continue;
          const checked = checkScalar(fieldType, row[name], `${key}[${i}].${name}`, TEXT_MAX_BYTES, rules);
          if (!checked.ok) return checked;
          kept[name] = checked.value;
        }
        rows.push(kept);
      }
      return { ok: true, value: rows };
    }
    const of = input.of ?? "text";
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === null) continue;
      const checked = checkScalar(of, value[i], `${key}[${i}]`, TEXT_MAX_BYTES);
      if (!checked.ok) return checked;
    }
    return { ok: true, value };
  }
  return { ok: false, code: "input_value_type", detail: `${key} has no known type` };
}

function coerceScalar(type        , value         )          {
  if (type === "number" && typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  }
  if (type === "text" && ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean")) {
    return String(value);
  }
  if (type === "bool" && (value === "true" || value === "false")) return value === "true";
  return value;
}

function coerceLiveUiInputValue(input                     , value         )          {
  const type = input && input.type;
  if (type === "number" || type === "text" || type === "bool") return coerceScalar(type, value);
  if (type !== "list" || !Array.isArray(value)) return value;
  if (input.fields) {
    const fields = input.fields;
    return value.map((row) => {
      if (!isPlainObject(row)) return row;
      const out                          = { ...row };
      for (const [name, fieldType] of Object.entries(fields)) if (own(row, name)) out[name] = coerceScalar(fieldType, row[name]);
      return out;
    });
  }
  const of = input.of ?? "text";
  return value.map((entry) => coerceScalar(of, entry));
}

module.exports = { LIVEUI_INPUT_KEY_RE, LIVEUI_INPUTS_MAX, LIVEUI_ERROR_INPUT_MAX_BYTES, validateLiveUiInputs, checkLiveUiInputValue, coerceLiveUiInputValue };
