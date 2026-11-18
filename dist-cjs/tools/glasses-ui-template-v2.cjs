const { LIVEUI_REGISTRY, LIVEUI_VOCAB } = require("./liveui-registry/index.cjs");
const { LIVEUI_PICTURE_DATA_MAX_CHARS } = require("./liveui-compiler/record-compiler.cjs");
const { validateStoredSurface } = require("./liveui-compiler/stored-surface.cjs");

const { validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");

const { sniffPicture } = require("./liveui-pictures/picture-sniff.cjs");
const { decodePictureDataUrl } = require("./liveui-pictures/picture-source.cjs");
const { fillLiveuiTemplate, sampleLiveuiTemplateValues, validateLiveuiTemplateSlotContract } = require("./glasses-ui-template-slots.cjs");

const LIVEUI_TEMPLATE_V2_SCHEMA_VERSION = 2;

const LIVEUI_TEMPLATE_V2_DIRNAME = "templates-v2";

const LIVEUI_TEMPLATE_ASSET_KEYS                    = Object.freeze([
  "template",
  "imageAsset",
  "imageBase64",
  "imageWidth",
  "imageHeight",
  "imageSlot",
]);
const ASSET_KEYS = new Set(LIVEUI_TEMPLATE_ASSET_KEYS);
const SUMMARY_MAX = 200;

const LIVEUI_TEMPLATE_V1_SAVED_SHAPE             = Object.freeze({
  fields: [
    "schemaVersion", "templateId", "itemType", "name", "defaults", "fields", "assets", "slots", "presentations",
    "helperOf", "recipe", "spec", "digest",
  ],
});

const LIVEUI_TEMPLATE_V2_SAVED_SHAPE             = Object.freeze({
  fields: [
    "schemaVersion", "templateId", "itemType", "name", "vocab", "body", "inputs", "refresh", "assets", "helperOf", "digest",
  ],
  parts: {
    body: {
      replaced: true,
      fields: ["surface", "preset"],
      parts: { preset: { replaced: true, fields: ["fields", "defaults", "presentations"] } },
    },
  },
});

const isObject = (v         )                           =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const copy =    (value   )    => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

const LIVEUI_TEMPLATE_PICTURES_MAX = 4;

const LIVEUI_TEMPLATE_PICTURES_TOTAL_MAX_CHARS = 262_144;
const PICTURE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PICTURE_DATA_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,/i;

const TEMPLATE_PICTURE_TYPES = new Set(["png", "jpeg", "gif", "webp"]);

function checkLiveuiTemplatePictures(assets         )                              {
  const bad = (code        , detail        )                              => ({ ok: false, code, detail });
  if (assets === undefined) return { ok: true, pictures: {} };
  const shape = 'assets must be { pictures: { <name>: "data:image/…;base64,…" } }';
  if (!isObject(assets)) return bad("template_assets_invalid", shape);
  const extra = Object.keys(assets).find((key) => key !== "pictures");
  if (extra) return bad("template_assets_invalid", `a composed template's assets hold only pictures, not ${extra}; ${shape}`);
  const pictures = assets.pictures === undefined ? {} : assets.pictures;
  if (!isObject(pictures)) return bad("template_assets_invalid", shape);
  const names = Object.keys(pictures);
  if (names.length > LIVEUI_TEMPLATE_PICTURES_MAX) {
    return bad("template_assets_invalid", `assets.pictures holds ${names.length} pictures; max ${LIVEUI_TEMPLATE_PICTURES_MAX}`);
  }
  const out                         = {};
  let total = 0;
  for (const name of names) {
    if (!PICTURE_NAME_RE.test(name)) return bad("template_assets_invalid", `picture name ${name} must match ${PICTURE_NAME_RE.source}`);
    const value = typeof pictures[name] === "string" ? (pictures[name]          ).trim() : "";

    if (!/^data:/i.test(value)) {
      return bad(
        "template_assets_invalid",
        `assets.pictures.${name} must be picture bytes (data:image/…;base64,…); a template holds no web address or file path as fixed media`,
      );
    }
    if (!PICTURE_DATA_RE.test(value)) return bad("picture_type_unsupported", `assets.pictures.${name} must be a PNG, JPEG, GIF or WebP`);
    const chars = value.length - value.indexOf(",") - 1;
    if (chars > LIVEUI_PICTURE_DATA_MAX_CHARS) {
      return bad("picture_too_large", `assets.pictures.${name} holds ${chars} base64 characters; max ${LIVEUI_PICTURE_DATA_MAX_CHARS}`);
    }
    total += chars;
    if (total > LIVEUI_TEMPLATE_PICTURES_TOTAL_MAX_CHARS) {
      return bad("picture_too_large", `assets.pictures hold over ${LIVEUI_TEMPLATE_PICTURES_TOTAL_MAX_CHARS} base64 characters in all`);
    }
    const decoded = decodePictureDataUrl(value);
    if (!decoded.ok) {
      const code = decoded.code === "picture_source_refused" ? "template_assets_invalid" : decoded.code;
      return bad(code, `assets.pictures.${name} is not a readable picture (${decoded.code})`);
    }

    const sniffed = sniffPicture(decoded.bytes);
    if (!sniffed.ok) {
      return bad(
        sniffed.code,
        sniffed.code === "picture_too_large"
          ? `assets.pictures.${name} is over the picture pixel cap`
          : `assets.pictures.${name} is not a PNG, JPEG, GIF or WebP`,
      );
    }
    if (!TEMPLATE_PICTURE_TYPES.has(sniffed.type)) {
      return bad("picture_type_unsupported", `assets.pictures.${name} is not a PNG, JPEG, GIF or WebP`);
    }
    out[name] = value;
  }
  return { ok: true, pictures: out };
}

function canonical(value         )      {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  const out                          = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}

function isLiveuiTemplateComposed(template         )          {
  return isObject(template) && isObject(template.body) && isObject(template.body.surface);
}

function isLiveuiTemplatePreset(template         )          {
  return isObject(template) && isObject(template.body) && isObject(template.body.preset);
}

function presetHasContract(template                  )          {
  const preset = (template.body                                        ).preset;
  return (Array.isArray(template.inputs) && template.inputs.length > 0) ||
    preset.presentations !== undefined || preset.defaults !== undefined;
}

function liveuiPresetVocab(fields         , defaults          )         {
  const kind = isObject(fields) && typeof fields.kind === "string"
    ? fields.kind
    : isObject(defaults) && typeof defaults.kind === "string" ? defaults.kind : null;
  const matches = LIVEUI_REGISTRY.presets.filter((p) => p.v1Kind === kind);
  return matches.length > 0 ? Math.max(...matches.map((p) => p.since)) : 1;
}

function liveuiTemplateV1ToV2(record                     )                   {
  const contract = record.slots !== undefined || record.presentations !== undefined;
  const spec = isObject(record.spec) ? record.spec : null;
  const refresh = record.recipe !== undefined ? record.recipe : spec && spec.refresh;
  let preset                          ;
  if (contract) {
    preset = {
      fields: copy(isObject(record.fields) ? record.fields : {}),
      defaults: copy(isObject(record.defaults) ? record.defaults : {}),
      ...(record.presentations === undefined ? {} : { presentations: copy(record.presentations) }),
    };
  } else {
    const base = spec ?? {
      ...(isObject(record.defaults) ? record.defaults : {}),
      ...(isObject(record.fields) ? record.fields : {}),
      ...(isObject(record.assets) ? record.assets : {}),
    };
    const { refresh: _stored, ...fields } = copy(base);
    preset = { fields };
  }
  return {
    schemaVersion: 2,
    templateId: record.templateId,
    name: record.name,
    vocab: liveuiPresetVocab(preset.fields, preset.defaults),
    body: { preset },
    inputs: contract ? copy(Array.isArray(record.slots) ? record.slots : []) : [],
    ...(refresh === undefined || refresh === null ? {} : { refresh: copy(refresh) }),
    assets: copy(isObject(record.assets) ? record.assets : {}),
    ...(record.helperOf === undefined ? {} : { helperOf: copy(record.helperOf) }),
    digest: record.digest,
  };
}

function presetTemplateAsV1Artifact(template                  )                           {
  if (!isLiveuiTemplatePreset(template)) throw new Error("template_body_invalid: not a Preset template");
  const preset = (template.body                                        ).preset;
  const base = {
    schemaVersion: 1         ,
    templateId: template.templateId,
    name: template.name,
  };
  const helper = template.helperOf === undefined ? {} : { helperOf: copy(template.helperOf) };
  const recipe = template.refresh === undefined ? {} : { recipe: copy(template.refresh) };
  if (presetHasContract(template)) {
    return {
      ...base,
      defaults: copy(isObject(preset.defaults) ? preset.defaults : {}),
      fields: copy(preset.fields),
      assets: copy(isObject(template.assets) ? template.assets : {}),
      slots: copy((Array.isArray(template.inputs) ? template.inputs : [])                        ),
      ...(preset.presentations === undefined ? {} : { presentations: copy(preset.presentations) }),
      ...recipe,
      ...helper,
    };
  }
  const fields                          = {};
  const assets                          = {};
  for (const [key, value] of Object.entries(preset.fields)) {
    if (key === "refresh") continue;
    if (ASSET_KEYS.has(key)) assets[key] = copy(value);
    else fields[key] = copy(value);
  }
  const { refresh: _inFields, ...specFields } = preset.fields;

  if (Object.keys(specFields).length === 0 && template.refresh === undefined) {
    return { ...base, defaults: {}, fields, assets, ...helper };
  }
  const spec = canonical({
    ...copy(specFields),
    ...(template.refresh === undefined ? {} : { refresh: copy(template.refresh) }),
  });
  return { ...base, defaults: {}, fields, assets, ...recipe, ...helper, spec };
}

function liveuiPresetTemplateSpec(template                  , validateSpec                     )                          {
  const artifact = presetTemplateAsV1Artifact(template);
  if (!presetHasContract(template)) return artifact.spec ?? {};
  const filled = fillLiveuiTemplate(artifact, sampleLiveuiTemplateValues(artifact)).spec;
  if (typeof validateSpec === "function") {
    const checked = validateSpec(filled);
    if (checked && checked.ok === true && checked.normalizedSpec) return canonical(checked.normalizedSpec);
  }
  return canonical(filled);
}

function liveuiTemplateV1View(template                  , validateSpec                     )                                  {
  if (!isLiveuiTemplatePreset(template)) return null;
  return {
    ...presetTemplateAsV1Artifact(template),
    spec: liveuiPresetTemplateSpec(template, validateSpec),
    digest: template.digest,
  };
}

function componentNouns(surface                     )           {
  const frame = LIVEUI_REGISTRY.frames.find((f) => f.name === surface.frame);
  const regions = isObject(surface.regions) ? surface.regions : {};
  const order = frame ? frame.regions.map((r) => r.name) : Object.keys(regions);
  const nouns           = [];
  for (const region of order) {
    for (const comp of Array.isArray(regions[region]) ? regions[region] : []) {
      const noun = LIVEUI_REGISTRY.components.find((c) => c.name === (comp       )?.c)?.noun;
      if (noun && !nouns.includes(noun)) nouns.push(noun);
    }
  }
  return nouns;
}

function liveuiPresetRowDescription(fields         , defaults         )         {
  const f = isObject(fields) ? fields : {};
  const d = isObject(defaults) ? defaults : {};
  const value = f.body || d.body || d.title;
  return typeof value === "string" && !value.includes("{{") ? value : "";
}

function liveuiTemplateRowDescription(template                     )         {
  if (template.schemaVersion !== LIVEUI_TEMPLATE_V2_SCHEMA_VERSION) {
    return liveuiPresetRowDescription(template.fields, template.defaults);
  }
  if (isLiveuiTemplateComposed(template)) return componentNouns(template.body.surface).join(", ");
  if (!isLiveuiTemplatePreset(template)) return "";
  const artifact = presetTemplateAsV1Artifact(template                    );
  return liveuiPresetRowDescription(artifact.fields, artifact.defaults);
}

function templateExampleSummary(template                  , validateSpec                     )                               {
  if (isLiveuiTemplateComposed(template)) {
    const surface = (template.body                                    ).surface;
    const keys = (Array.isArray(template.inputs) ? template.inputs : [])
      .map((i     ) => i && i.key)
      .filter((k         ) => typeof k === "string");
    const parts = [String(surface.frame), componentNouns(surface).join(", ") || "no components"];
    if (keys.length > 0) parts.push(`Inputs: ${keys.join(", ")}`);
    return { form: "composed", summary: parts.join(" · ").slice(0, SUMMARY_MAX) };
  }
  const artifact = presetTemplateAsV1Artifact(template);
  return {
    form: "preset",
    spec: liveuiPresetTemplateSpec(template, validateSpec),
    slots: artifact.slots ?? [],
  };
}

function validateLiveuiTemplateV2Record(record         )                        {
  const bad = (code        , detail        )                        => ({ ok: false, code, detail });
  if (!isObject(record)) return bad("library_record_malformed", "not an object");
  if (!Number.isInteger(record.vocab) || record.vocab < 1) return bad("library_record_malformed", "vocab is not a positive integer");
  if (record.vocab > LIVEUI_VOCAB) return bad("template_vocab_newer", `vocab ${record.vocab} is newer than ${LIVEUI_VOCAB}`);
  const body = record.body;
  const forms = isObject(body) ? Object.keys(body) : [];
  if (forms.length !== 1 || !["surface", "preset"].includes(forms[0]) || !isObject(body[forms[0]])) {
    return bad("template_body_invalid", "body holds exactly one of surface or preset");
  }
  if (!Array.isArray(record.inputs)) return bad("library_record_malformed", "inputs is not an array");
  if (record.refresh !== undefined && !isObject(record.refresh)) return bad("library_record_malformed", "refresh is not an object");
  if (record.helperOf !== undefined && !(isObject(record.helperOf) && typeof record.helperOf.taskId === "string")) {
    return bad("library_record_malformed", "helperOf is not { taskId }");
  }
  if (forms[0] === "surface") {
    const inputs = validateLiveUiInputs(record.inputs);
    if (!inputs.ok) return bad(inputs.code, inputs.message);

    const pictures = checkLiveuiTemplatePictures(record.assets);
    if (!pictures.ok) return bad(pictures.code, pictures.detail);
    const surface = validateStoredSurface(body.surface, { inputs: inputs.inputs, assets: Object.keys(pictures.pictures) });
    if (!surface.ok) return bad(surface.code, surface.detail);
    return { ok: true };
  }
  const preset = body.preset;
  if (!isObject(preset.fields)) return bad("template_fields_invalid", "fields must be an object");
  for (const section of ["defaults", "presentations"]) {
    if (preset[section] !== undefined && !isObject(preset[section])) return bad("template_section_invalid", `${section} must be an object`);
  }
  const extra = Object.keys(preset).find((k) => !["fields", "defaults", "presentations"].includes(k));
  if (extra) return bad("template_field_unknown", `unknown preset field: ${extra}`);
  if (record.assets !== undefined && !isObject(record.assets)) return bad("template_section_invalid", "assets must be an object");
  const artifact = presetTemplateAsV1Artifact(record                    );
  if (artifact.slots !== undefined || artifact.presentations !== undefined) {
    const contract = validateLiveuiTemplateSlotContract(artifact);
    if (!contract.ok) return bad((contract       ).code, (contract       ).message);
  }
  return { ok: true };
}

const LIVEUI_TEMPLATE_V2_SAVE_SCHEMA = Object.freeze({
  type: "object",
  required: ["schemaVersion", "templateId", "name", "body"],
  properties: {
    schemaVersion: { const: 2 },
    templateId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
    name: { type: "string", minLength: 1, maxLength: 120 },
    body: {
      description:
        "Exactly one. records: the surface as <ui …> records, frame record first, with no actions; " +
        "the plugin compiles them. preset: a V1 kind's fields, defaults and presentations, " +
        "where {{slot.key}} text reads an input.",
      oneOf: [
        {
          type: "object",
          required: ["records"],
          properties: { records: { type: "string" } },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["preset"],
          properties: {
            preset: {
              type: "object",
              required: ["fields"],
              properties: { fields: { type: "object" }, defaults: { type: "object" }, presentations: { type: "object" } },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      ],
    },
    inputs: {
      type: "array",
      maxItems: 16,
      description:
        "records: each input k is the data key data.k; error is reserved. preset: V1 slots.",
      items: {
        type: "object",
        required: ["key", "type"],
        properties: {
          key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
          type: { enum: ["number", "text", "bool", "list", "image"] },
          label: { type: "string", maxLength: 64 },
          required: { type: "boolean" },
          min: { type: "number" },
          max: { type: "number" },
          maxBytes: { type: "integer", minimum: 1, maximum: 999 },
          maxItems: { type: "integer", minimum: 1, maximum: 20 },
          of: { enum: ["number", "text", "bool"] },
          fields: { type: "object", additionalProperties: { enum: ["number", "text", "bool", "image"] } },
        },
      },
    },
    refresh: {
      type: "object",
      description:
        "Optional. recipe, intervalMs, maxDurationMs, maxConsecutiveFailures, onError " +
        "(keep_last, show_error, stop); for records, targets maps input keys to JSON Pointers " +
        "into the recipe output (\"\" is all of it).",
    },
    assets: {
      type: "object",
      description:
        "Optional. records: only pictures, the template's own fixed pictures by name; src=\"<name>\" shows one. " +
        "A stored template holds no web address or file path; an image input carries those. preset: V1 assets.",
      properties: {
        pictures: {
          type: "object",
          maxProperties: LIVEUI_TEMPLATE_PICTURES_MAX,
          description: `At most ${LIVEUI_TEMPLATE_PICTURES_MAX}, ${LIVEUI_TEMPLATE_PICTURES_TOTAL_MAX_CHARS} base64 characters in all.`,
          propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_-]{0,31}$" },
          additionalProperties: {
            type: "string",
            pattern: "^data:image/(png|jpeg|gif|webp);base64,",
            description: `PNG, JPEG, GIF or WebP bytes, data:image/…;base64,…, at most ${LIVEUI_PICTURE_DATA_MAX_CHARS} base64 characters.`,
          },
        },
      },
    },
  },
  additionalProperties: false,
});

module.exports = { LIVEUI_TEMPLATE_V2_SCHEMA_VERSION, LIVEUI_TEMPLATE_V2_DIRNAME, LIVEUI_TEMPLATE_ASSET_KEYS, LIVEUI_TEMPLATE_V1_SAVED_SHAPE, LIVEUI_TEMPLATE_V2_SAVED_SHAPE, LIVEUI_TEMPLATE_PICTURES_MAX, LIVEUI_TEMPLATE_PICTURES_TOTAL_MAX_CHARS, checkLiveuiTemplatePictures, isLiveuiTemplateComposed, isLiveuiTemplatePreset, liveuiPresetVocab, liveuiTemplateV1ToV2, presetTemplateAsV1Artifact, liveuiPresetTemplateSpec, liveuiTemplateV1View, liveuiPresetRowDescription, liveuiTemplateRowDescription, templateExampleSummary, validateLiveuiTemplateV2Record, LIVEUI_TEMPLATE_V2_SAVE_SCHEMA };
