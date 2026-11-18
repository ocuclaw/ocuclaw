const fs = require("node:fs");

const path = require("node:path");
const { LIVEUI_LIBRARY_ITEM_TYPES, canonicalSerialize, createLiveuiLibrary, isValidLiveuiLibraryItemId, projectLiveuiLibraryForGlasses, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { listKindItemSchemas, validateKindItemAgainstGrammar } = require("./glasses-ui-descriptors.cjs");
const { isTerminalOutcome } = require("./glasses-ui-surfaces.cjs");
const { refreshSchemaForToolParams } = require("./glasses-ui-refresh-schema.cjs");
const { projectLiveuiTaskRunForPhone } = require("./glasses-ui-task-run.cjs");
const { isLiveuiSwitchedOff, liveuiDisabledResult } = require("./glasses-ui-prefs.cjs");
const { GLASSES_UI_LIMITS, LIVEUI_TEMPLATE_RENDER_TIMEOUT_MAX_MS } = require("./glasses-ui-limits.cjs");
const { LIVEUI_TEMPLATE_SLOT_JSON_MAX_BYTES, LIVEUI_TEMPLATE_SLOT_LIST_MAX, LIVEUI_TEMPLATE_SLOT_MAX, LIVEUI_TEMPLATE_SLOT_TEXT_MAX, copyLiveuiStaticJson, fillLiveuiTemplate, previewLiveuiTemplatePresentation, sampleLiveuiTemplateValues, validateLiveuiTemplateSlotContract } = require("./glasses-ui-template-slots.cjs");
const { LIVEUI_TEMPLATE_ASSET_KEYS, LIVEUI_TEMPLATE_V2_SAVE_SCHEMA, LIVEUI_TEMPLATE_V2_SCHEMA_VERSION, checkLiveuiTemplatePictures, liveuiPresetVocab, liveuiTemplateV1ToV2, liveuiTemplateV1View } = require("./glasses-ui-template-v2.cjs");
const { compileStoredSurfaceRecords, validateStoredSurface } = require("./liveui-compiler/stored-surface.cjs");
const { validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");
const { isOcuclawCardId } = require("./glasses-ui-ocuclaw-cards.cjs");
const { taskFitLog, taskFitReasons, validTaskFixes } = require("./glasses-ui-task-fit.cjs");
const { createTaskFitStore, taskFitRecordFor } = require("./glasses-ui-task-fit-records.cjs");
const { taskToolReasons } = require("./glasses-ui-task-tool-failures.cjs");
const { LIVEUI_TEMPLATE_VALUES_HEADING_MAX, LIVEUI_TEMPLATE_VALUES_SCHEMA_VERSION, applyTaskResultToTemplateValues, checkDeliveredTemplateValues, deliveredTemplateUnchecked, findLiveuiTemplateValues, liveuiDeliveredTitle, liveuiUncheckedTitle, passiveTemplateValues, templateUncheckedOpen, readLiveuiTemplateValues, removeLiveuiTemplateValues, removeLiveuiTemplateValuesOwner, writeLiveuiTemplateValues } = require("./glasses-ui-template-values.cjs");

const LIVEUI_TEMPLATE_LIBRARY_SCHEMA_VERSION =
  LIVEUI_LIBRARY_ITEM_TYPES.template.schemaVersion;
const LIVEUI_TEMPLATE_LIBRARY_DIRNAME = "templates-v1";
const LIVEUI_TEMPLATE_TOOL_NAME = "manage_liveui_templates";

const activeLibraryTemplateSurfaceByHandler = new WeakMap();

const LIVEUI_TEMPLATE_TOOL_DESCRIPTION = [
  "Manage reusable code-free LiveUI Templates and inspect the owner Library.",
  "Templates are declarative only: Engine fields, defaults, image assets, and",
  "already-supported refresh recipes. Saving validates and hashes content; it",
  "never imports modules, installs packages, starts a runtime, or executes content.",
  "Use save with template, read/render with templateId, list for Templates",
  "only, or list_library for every saved Library item type.",
].join("\n");

const graphicFieldSchema = {
  type: "object",
  required: ["slots"],
  properties: {
    slots: {
      type: "array",
      minItems: 1,
      maxItems: GLASSES_UI_LIMITS.graphicSlotsMax,
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string" },
          label: { type: "string" },
          icon: { type: "string" },
        },
        additionalProperties: { type: "string" },
      },
    },
  },
  additionalProperties: false,
};

const engineFieldProperties = {
  kind: { type: "string" },
  title: { type: "string" },
  body: { type: "string" },
  items: {
    anyOf: [
      {
        type: "array",
        items: {
          anyOf: listKindItemSchemas(),
        },
      },
      {
        type: "string",
        description: "Whole-array list slot reference: {{slot.<key>}}",
      },
    ],
  },
  update: { type: "string", enum: ["replace", "patch", "push"] },
  timeoutMs: {
    type: "integer",
    maximum: LIVEUI_TEMPLATE_RENDER_TIMEOUT_MAX_MS,
  },
  staleAfterMs: { type: "integer" },
  queueMode: { type: "string" },
  graphic: graphicFieldSchema,
  durationPicker: {type:"string",description:"Whole-object JSON input reference for a duration_picker: {{slot.duration_picker}}."},
};

const engineFieldsSchema = {
  type: "object",
  properties: engineFieldProperties,
  additionalProperties: false,
};

const assetProperties = {
  template: { type: "string", enum: ["image_caption", "graphic", "graphic_v2", "duration_picker"] },
  imageAsset: { type: "string" },
  imageBase64: { type: "string" },
  imageWidth: { type: "integer" },
  imageHeight: { type: "integer" },
  imageSlot: { type: "string" },
};

const slotCommonProperties = {
  key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
  label: { type: "string", maxLength: 80 },
  required: { type: "boolean" },
};

const slotsSchema = {
  type: "array",
  maxItems: LIVEUI_TEMPLATE_SLOT_MAX,
  items: {
    oneOf: [
      {
        type: "object",
        required: ["key", "type"],
        properties: {
          ...slotCommonProperties,
          type: { const: "text" },
          maxLength: { type: "integer", minimum: 1, maximum: LIVEUI_TEMPLATE_SLOT_TEXT_MAX },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["key", "type", "min", "max"],
        properties: {
          ...slotCommonProperties,
          type: { const: "number" },
          min: { type: "number" },
          max: { type: "number" },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["key", "type"],
        properties: {
          ...slotCommonProperties,
          type: { const: "list" },
          maxItems: { type: "integer", minimum: 1, maximum: LIVEUI_TEMPLATE_SLOT_LIST_MAX },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["key", "type"],
        properties: {
          ...slotCommonProperties,
          type: { const: "image" },
        },
        additionalProperties: false,
      },
      {

        type: "object",
        required: ["key", "type"],
        properties: {
          ...slotCommonProperties,
          type: { const: "json" },
          maxBytes: { type: "integer", minimum: 1, maximum: LIVEUI_TEMPLATE_SLOT_JSON_MAX_BYTES },
        },
        additionalProperties: false,
      },
    ],
  },
};

const fragmentSchema = {
  type: "object",
  properties: {
    title: { type: "string", maxLength: GLASSES_UI_LIMITS.titleMax },
    body: { type: "string", maxLength: GLASSES_UI_LIMITS.bodyMax },
    items: {
      type: "array",
      minItems: 1,
      maxItems: GLASSES_UI_LIMITS.maxItems,
      items: { type: "string", maxLength: GLASSES_UI_LIMITS.itemMax },
    },
  },
  additionalProperties: false,
};

const presentationsSchema = {
  type: "object",
  properties: {
    loading: fragmentSchema,
    empty: fragmentSchema,
    error: fragmentSchema,
    pages: {
      type: "object",
      required: ["pages"],
      properties: {
        pages: {
          type: "array",
          minItems: 1,
          maxItems: GLASSES_UI_LIMITS.maxPages,
          items: { type: "string", maxLength: GLASSES_UI_LIMITS.pageMax },
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const templateArtifactProperties = {
  schemaVersion: { const: LIVEUI_TEMPLATE_LIBRARY_SCHEMA_VERSION },
  templateId: { type: "string" },
  name: { type: "string" },
  defaults: engineFieldsSchema,
  fields: engineFieldsSchema,
  assets: {
    type: "object",
    properties: assetProperties,
    additionalProperties: false,
  },
  recipe: refreshSchemaForToolParams,
  slots: slotsSchema,
  presentations: presentationsSchema,
};

const templateArtifactSchema = {
  type: "object",
  required: ["schemaVersion", "templateId", "name", "fields"],
  properties: templateArtifactProperties,
  additionalProperties: false,
};

const liveuiTemplateToolParametersSchema = {
  type: "object",
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: ["save", "read", "list", "list_library", "render"],
    },
    templateId: { type: "string" },
    template: templateArtifactSchema,
    expectedDigest: { type: "string" },
    values: {
      type: "object",
      description: "Ephemeral values for the Template's declared slots.",
      additionalProperties: {
        anyOf: [
          { type: "string" },
          { type: "number" },
          {

            type: "array",
            items: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
              ],
            },
          },
          {
            type: "object",
            properties: {
              imageAsset: { type: "string" },
              imageBase64: { type: "string" },
              imageWidth: { type: "integer" },
              imageHeight: { type: "integer" },
            },
            additionalProperties: false,
          },
        ],
      },
    },
  },
  additionalProperties: false,
};

const liveuiTemplateLeanToolParametersSchema = {
  ...liveuiTemplateToolParametersSchema,
  properties: {
    ...liveuiTemplateToolParametersSchema.properties,
    operation: {
      type: "string",
      enum: ["save", "read", "list", "list_library", "render", "schema"],
    },
    template: {
      type: "object",
      description:
        "The Template to save. Its shape is strict (schemaVersion, templateId, name, fields; " +
        "optional defaults, assets, recipe, slots, presentations). Call operation \"schema\" " +
        "before your first save to get the exact JSON Schema.",
    },
  },
};

function liveuiTemplateToolParametersSchemaFor(mode     ) {
  return mode === "lean" ? liveuiTemplateLeanToolParametersSchema : liveuiTemplateToolParametersSchema;
}

function propertyKeys(schema     ) {
  return new Set(Object.keys(schema.properties || {}));
}

const TOP_LEVEL_KEYS = propertyKeys(templateArtifactSchema);
const ENGINE_FIELD_KEYS = propertyKeys(engineFieldsSchema);
const ASSET_KEYS = propertyKeys(templateArtifactProperties.assets);
const TEMPLATE_NAME_MAX = 120;
const TEMPLATE_MAX_BYTES = 256 * 1024;

const V2_TOP_LEVEL_KEYS = new Set([
  "schemaVersion", "templateId", "name", "vocab", "body", "inputs", "refresh", "assets", "digest",
]);
const PRESET_BODY_KEYS = new Set(["fields", "defaults", "presentations"]);

function rejected(code     , message     ) {
  return { status: "rejected", code, message };
}

function recordPictureChars(record     )         {
  const pictures = record && record.body && record.body.surface && record.assets && record.assets.pictures;
  if (!pictures || typeof pictures !== "object") return 0;
  let chars = 0;
  for (const value of Object.values(pictures)) if (typeof value === "string") chars += value.length;
  return chars;
}

function validateHelperOf(value     ) {
  if (value === undefined) return { status: "accepted", helperOf: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(value, "taskId") ||
      !isValidLiveuiLibraryItemId(value.taskId)) {
    return rejected("template_helper_invalid", "helperOf must be exactly { taskId }");
  }
  return { status: "accepted", helperOf: { taskId: value.taskId } };
}

function unknownKey(value     , allowed     ) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).find((key) => !allowed.has(key)) || null;
}

function firstEngineDroppedPath(input     , normalized     , currentPath = "recipe")      {
  if (Array.isArray(input)) {
    if (!Array.isArray(normalized)) return currentPath;
    for (let index = 0; index < input.length; index += 1) {
      if (index >= normalized.length) return `${currentPath}[${index}]`;
      const dropped = firstEngineDroppedPath(
        input[index],
        normalized[index],
        `${currentPath}[${index}]`,
      );
      if (dropped) return dropped;
    }
    return null;
  }
  if (!input || typeof input !== "object") return null;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    return currentPath;
  }
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(normalized, key)) {
      return `${currentPath}.${key}`;
    }
    const dropped = firstEngineDroppedPath(
      input[key],
      normalized[key],
      `${currentPath}.${key}`,
    );
    if (dropped) return dropped;
  }
  return null;
}

function resolveLiveuiTemplateLibraryDir(libraryDir     ) {
  if (typeof libraryDir === "string" && libraryDir.trim()) return path.resolve(libraryDir.trim());
  return path.join(resolveLiveuiLibraryRoot(undefined), LIVEUI_TEMPLATE_LIBRARY_DIRNAME);
}

function validateEnvelope(input     )      {
  let template;
  try {
    template = copyLiveuiStaticJson(input);
  } catch (err     ) {
    return rejected("template_not_static_data", err && err.message ? err.message : String(err));
  }
  const topUnknown = unknownKey(template, TOP_LEVEL_KEYS);
  if (topUnknown) return rejected("template_field_unknown", `unknown template field: ${topUnknown}`);
  if (template.schemaVersion !== LIVEUI_TEMPLATE_LIBRARY_SCHEMA_VERSION) {
    return rejected(
      "template_schema_unsupported",
      `schemaVersion must be ${LIVEUI_TEMPLATE_LIBRARY_SCHEMA_VERSION}`,
    );
  }
  if (!isValidLiveuiLibraryItemId(template.templateId)) {
    return rejected(
      "template_id_invalid",
      "templateId must be 1-64 lowercase letters, digits, dot, underscore, or hyphen, and a new one must not end in .json",
    );
  }
  if (
    typeof template.name !== "string" ||
    !template.name.trim() ||
    template.name.length > TEMPLATE_NAME_MAX
  ) {
    return rejected("template_name_invalid", `name must be 1-${TEMPLATE_NAME_MAX} characters`);
  }
  if (!template.fields || typeof template.fields !== "object" || Array.isArray(template.fields)) {
    return rejected("template_fields_invalid", "fields must be an object");
  }
  const mergedKind = template.fields.kind === undefined
    ? template.defaults && template.defaults.kind
    : template.fields.kind;
  const sections      = [
    ["fields", ENGINE_FIELD_KEYS],
    ["defaults", ENGINE_FIELD_KEYS],
    ["assets", ASSET_KEYS],
  ];
  for (const [section, allowed] of sections) {
    const value = template[section];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return rejected("template_section_invalid", `${section} must be an object`);
    }
    const extra = unknownKey(value, allowed);
    if (extra) return rejected("template_field_unknown", `unknown ${section} field: ${extra}`);
    if ((section === "fields" || section === "defaults") &&
        Number.isFinite(value.timeoutMs) &&
        value.timeoutMs > LIVEUI_TEMPLATE_RENDER_TIMEOUT_MAX_MS) {
      return rejected(
        "template_timeout_unsupported",
        `template ${section}.timeoutMs must be at most ${LIVEUI_TEMPLATE_RENDER_TIMEOUT_MAX_MS}`,
      );
    }
    if ((section === "fields" || section === "defaults") && value.items !== undefined) {
      if (!Array.isArray(value.items) && typeof value.items !== "string") {
        return rejected("template_items_invalid", `${section}.items must be an array`);
      }
      if (typeof value.items === "string") continue;
      for (let index = 0; index < value.items.length; index += 1) {
        const item = value.items[index];
        const itemValidation = validateKindItemAgainstGrammar(mergedKind, item);
        if (itemValidation.code === "items_unsupported") {
          return rejected(
            "template_items_invalid",
            `${section}.items are not supported for ${mergedKind || "this template"}`,
          );
        }
        if (itemValidation.code === "unknown_field") {
          return rejected(
            "template_field_unknown",
            `unknown ${section}.items[${index}] field: ${itemValidation.field}`,
          );
        }
        if (!itemValidation.ok) {
          return rejected(
            "template_items_invalid",
            `${section}.items[${index}] does not match the ${mergedKind || "Engine"} item grammar`,
          );
        }
      }
    }
  }
  const slotContract = validateLiveuiTemplateSlotContract(template);
  if (!slotContract.ok) return rejected(slotContract.code, slotContract.message);
  const bytes = new TextEncoder().encode(canonicalSerialize(template)).byteLength;
  if (bytes > TEMPLATE_MAX_BYTES) {
    return rejected("template_too_large", `template is ${bytes} bytes; max ${TEMPLATE_MAX_BYTES}`);
  }
  return { status: "accepted", template };
}

function createLiveuiTemplateLibrary(opts      = {}) {
  const libraryDir = resolveLiveuiTemplateLibraryDir(opts.libraryDir);
  const libraryRoot =
    typeof opts.libraryDir === "string" && opts.libraryDir.trim()
      ? path.dirname(libraryDir)
      : resolveLiveuiLibraryRoot(undefined);
  const library = createLiveuiLibrary({
    libraryDir: libraryRoot,
    manageLibraryDir: !(typeof opts.libraryDir === "string" && opts.libraryDir.trim()),
    typeDirectories: { template: libraryDir },
  });
  const validateSpec = typeof opts.validateSpec === "function" ? opts.validateSpec : null;
  const templateV2Dir         = library.templateV2Directory();

  function recordPath(templateId     ) {
    return path.join(libraryDir, `${templateId}.json`);
  }

  function loadRecord(templateId     )      {

    if (isOcuclawCardId(templateId)) return { record: library.loadItem("template", templateId).record };
    const inV1 = fs.existsSync(recordPath(templateId));
    const inV2 = fs.existsSync(path.join(templateV2Dir, `${templateId}.json`));
    if (!inV1 && !inV2) return null;
    const loaded = library.loadItem("template", templateId);
    if (loaded.status === "accepted") return { record: loaded.record };
    if (loaded.reason === "library_digest_mismatch") {
      throw new Error(`template_library_corrupt: digest mismatch for ${templateId}`);
    }
    if (inV2) {
      return {
        rejected: rejected(loaded.reason || "template_invalid", `template ${templateId} cannot be read: ${loaded.reason}`),
      };
    }
    throw new Error(`template_library_corrupt: invalid record ${templateId}`);
  }

  function heldId(templateId        ) {
    if (isOcuclawCardId(templateId)) return true;
    return fs.existsSync(recordPath(templateId)) || fs.existsSync(path.join(templateV2Dir, `${templateId}.json`));
  }

  function idClash(templateId        ) {
    if (heldId(templateId)) return null;
    if (templateId.endsWith(".json")) {
      return rejected("template_id_invalid", "templateId must not end in .json");
    }
    const twin = `${templateId}.json`;
    if (isValidLiveuiLibraryItemId(twin) && heldId(twin)) {
      return rejected("template_id_invalid", `templateId ${templateId} clashes with template ${twin}; save under another templateId`);
    }
    return null;
  }

  function readRecord(templateId     ) {
    if (!isValidLiveuiLibraryItemId(templateId)) {
      return rejected("template_id_invalid", "templateId is invalid");
    }
    const loaded = loadRecord(templateId);
    if (!loaded) return rejected("template_not_found", `template not found: ${templateId}`);
    if (loaded.rejected) return loaded.rejected;
    return acceptedRecord("accepted", loaded.record);
  }

  function validateV1Artifact(input     , options      = {})      {
    const envelope      = validateEnvelope(input);
    if (envelope.status !== "accepted") return envelope;
    const artifact = envelope.template;
    const hasSlotContract = artifact.slots !== undefined || artifact.presentations !== undefined;

    const sampleValues = hasSlotContract ? sampleLiveuiTemplateValues(artifact) : {};
    const filled      = hasSlotContract
      ? fillLiveuiTemplate(artifact, sampleValues)
      : null;
    const spec = hasSlotContract
      ? filled.spec
      : {
          ...(artifact.defaults || {}),
          ...artifact.fields,
          ...(artifact.assets || {}),
          ...(artifact.recipe === undefined ? {} : { refresh: artifact.recipe }),
        };
    const validation = validateSpec
      ? validateSpec(spec)
      : { ok: true, normalizedSpec: spec, errors: [] };
    let validationOk = !!(validation && validation.ok === true && validation.normalizedSpec);

    if (!validationOk && hasSlotContract && options.helperOf !== undefined &&
        options.selfCheckValues && typeof options.selfCheckValues === "object" &&
        !Array.isArray(options.selfCheckValues)) {
      const realFilled = fillLiveuiTemplate(artifact, options.selfCheckValues);
      const realValidation = realFilled.status === "filled" && validateSpec
        ? validateSpec(realFilled.spec)
        : { ok: false };
      validationOk = !!(realValidation && realValidation.ok === true);
    }
    if (!validationOk) {
      const first = validation && Array.isArray(validation.errors) ? validation.errors[0] : null;
      return rejected(
        first && first.code ? first.code : "template_spec_invalid",
        first && first.message ? first.message : "template spec failed LiveUI Engine validation",
      );
    }

    const persistedSpec = validation && validation.ok === true && validation.normalizedSpec
      ? validation.normalizedSpec
      : spec;
    if (artifact.recipe !== undefined) {
      const droppedPath = firstEngineDroppedPath(
        artifact.recipe,
        persistedSpec.refresh,
      );
      if (droppedPath) {
        return rejected(
          "template_field_unknown",
          `LiveUI Engine did not approve template field: ${droppedPath}`,
        );
      }
    }
    if (hasSlotContract && validateSpec) {
      for (const state of ["loading", "empty", "error"]) {
        if (!artifact.presentations || artifact.presentations[state] === undefined) continue;
        const candidate = previewLiveuiTemplatePresentation(
          artifact,
          state,
          sampleValues,
          "validation error",
        );
        const candidateValidation = validateSpec(candidate);
        if (!candidateValidation || candidateValidation.ok !== true ||
            !candidateValidation.normalizedSpec) {
          const first = candidateValidation && Array.isArray(candidateValidation.errors)
            ? candidateValidation.errors[0]
            : null;
          return rejected(
            first && first.code ? first.code : "template_presentations_invalid",
            first && first.message
              ? first.message
              : `presentations.${state} failed LiveUI Engine validation`,
          );
        }
      }
    }
    return { status: "accepted", artifact, persistedSpec };
  }

  function v2FromV1Artifact(artifact     , persistedSpec     , helperOf     ) {
    const hasSlotContract = artifact.slots !== undefined || artifact.presentations !== undefined;
    const { refresh: _refresh, ...specFields } = persistedSpec;
    const preset = hasSlotContract
      ? {
          fields: artifact.fields,
          defaults: artifact.defaults || {},
          ...(artifact.presentations === undefined ? {} : { presentations: artifact.presentations }),
        }
      : { fields: specFields };
    return {
      schemaVersion: LIVEUI_TEMPLATE_V2_SCHEMA_VERSION,
      templateId: artifact.templateId,
      name: artifact.name.trim(),
      vocab: liveuiPresetVocab(preset.fields, (preset       ).defaults),
      body: { preset },
      inputs: hasSlotContract ? artifact.slots || [] : [],
      ...(persistedSpec.refresh === undefined ? {} : { refresh: persistedSpec.refresh }),
      assets: artifact.assets || {},
      ...(helperOf === undefined ? {} : { helperOf }),
    };
  }

  function v2FromEnvelope(input     , options     , helperOf     )      {
    let template     ;
    try {
      template = copyLiveuiStaticJson(input);
    } catch (err     ) {
      return rejected("template_not_static_data", err && err.message ? err.message : String(err));
    }
    const topUnknown = unknownKey(template, V2_TOP_LEVEL_KEYS);
    if (topUnknown) return rejected("template_field_unknown", `unknown template field: ${topUnknown}`);
    if (!isValidLiveuiLibraryItemId(template.templateId)) {
      return rejected(
        "template_id_invalid",
        "templateId must be 1-64 lowercase letters, digits, dot, underscore, or hyphen, and a new one must not end in .json",
      );
    }
    if (typeof template.name !== "string" || !template.name.trim() || template.name.length > TEMPLATE_NAME_MAX) {
      return rejected("template_name_invalid", `name must be 1-${TEMPLATE_NAME_MAX} characters`);
    }
    const body = template.body;
    const forms = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (forms.length !== 1 || !["records", "surface", "preset"].includes(forms[0])) {
      return rejected("template_body_invalid", "body must hold exactly one of records, surface or preset");
    }
    if (template.refresh !== undefined &&
        (!template.refresh || typeof template.refresh !== "object" || Array.isArray(template.refresh))) {
      return rejected("template_refresh_invalid", "refresh must be an object");
    }
    if (forms[0] === "preset") {
      const preset = body.preset;
      if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
        return rejected("template_fields_invalid", "preset must be an object");
      }
      const presetUnknown = unknownKey(preset, PRESET_BODY_KEYS);
      if (presetUnknown) return rejected("template_field_unknown", `unknown preset field: ${presetUnknown}`);
      const inputs = template.inputs === undefined ? [] : template.inputs;
      const hasContract = (Array.isArray(inputs) && inputs.length > 0) || preset.presentations !== undefined;
      let fields = preset.fields;
      let assets = template.assets;
      let recipe = template.refresh;
      if (!hasContract && fields && typeof fields === "object" && !Array.isArray(fields)) {

        fields = {};
        assets = { ...(template.assets || {}) };
        for (const [key, value] of Object.entries(preset.fields)) {
          if (key === "refresh") recipe = recipe === undefined ? value : recipe;
          else if (LIVEUI_TEMPLATE_ASSET_KEYS.includes(key)) assets[key] = value;
          else fields[key] = value;
        }
      }
      const artifact = {
        schemaVersion: LIVEUI_TEMPLATE_LIBRARY_SCHEMA_VERSION,
        templateId: template.templateId,
        name: template.name,
        fields,
        ...(preset.defaults === undefined ? {} : { defaults: preset.defaults }),
        ...(assets === undefined ? {} : { assets }),
        ...(recipe === undefined ? {} : { recipe }),
        ...(hasContract ? { slots: inputs } : {}),
        ...(preset.presentations === undefined ? {} : { presentations: preset.presentations }),
      };
      const checked = validateV1Artifact(artifact, options);
      if (checked.status !== "accepted") return checked;
      return { status: "accepted", record: v2FromV1Artifact(checked.artifact, checked.persistedSpec, helperOf) };
    }
    const inputs = validateLiveUiInputs(template.inputs === undefined ? [] : template.inputs);
    if (!inputs.ok) return rejected(inputs.code, inputs.message);

    const own = checkLiveuiTemplatePictures(template.assets);
    if (!own.ok) return rejected(own.code, own.detail);
    const assetNames = Object.keys(own.pictures);
    let surface     ;
    let vocab        ;
    if (forms[0] === "records") {
      const compiled = compileStoredSurfaceRecords(body.records, { inputs: inputs.inputs, assets: assetNames });
      if (!compiled.ok) return rejected(compiled.code, compiled.detail);
      surface = compiled.surface;
      vocab = compiled.vocab;
    } else {
      const checked = validateStoredSurface(body.surface, { inputs: inputs.inputs, assets: assetNames });
      if (!checked.ok) return rejected(checked.code, checked.detail);
      surface = body.surface;
      vocab = checked.vocab;
    }
    const refreshProblem = composedRefreshProblem(template.refresh, inputs.inputs);
    if (refreshProblem) return rejected("template_refresh_invalid", refreshProblem);
    return {
      status: "accepted",
      record: {
        schemaVersion: LIVEUI_TEMPLATE_V2_SCHEMA_VERSION,
        templateId: template.templateId,
        name: template.name.trim(),
        vocab,
        body: { surface },
        inputs: inputs.inputs,
        ...(template.refresh === undefined ? {} : { refresh: template.refresh }),
        ...(assetNames.length === 0 ? {} : { assets: { pictures: own.pictures } }),
        ...(helperOf === undefined ? {} : { helperOf }),
      },
    };
  }

  function templateView(record     ) {
    if (record.schemaVersion !== LIVEUI_TEMPLATE_V2_SCHEMA_VERSION) return record;
    return liveuiTemplateV1View(record, validateSpec || undefined) || record;
  }

  function acceptedRecord(status        , record     ) {
    return {
      status,
      template: templateView(record),
      envelope: record.schemaVersion === LIVEUI_TEMPLATE_V2_SCHEMA_VERSION
        ? record
        : liveuiTemplateV1ToV2(record),
    };
  }

  function writeRecord(record     , options     ) {
    const bytes = new TextEncoder().encode(canonicalSerialize(record)).byteLength;

    const pictureChars = recordPictureChars(record);
    if (bytes - pictureChars > TEMPLATE_MAX_BYTES) {
      return rejected(
        "template_too_large",
        `template is ${bytes - pictureChars} bytes${pictureChars > 0 ? " beside its pictures" : ""}; max ${TEMPLATE_MAX_BYTES}`,
      );
    }

    const saved = library.saveItem("template", record.templateId, record, {
      ...options,
      carryMaxBytes: TEMPLATE_MAX_BYTES + pictureChars,
    });
    if (saved.status === "invalid" && saved.reason === "library_schema_unsupported") {

      return {
        ...rejected(
          "library_schema_unsupported",
          `template ${record.templateId} was saved by a newer version of OcuClaw and is left as it is; save under another templateId`,
        ),
        reason: saved.reason,
      };
    }
    if (saved.status !== "saved") return saved;
    return acceptedRecord("saved", saved.record);
  }

  function readIds() {
    const ids = new Set        ();
    for (const directory of [libraryDir, templateV2Dir]) {
      let names;
      try {
        names = fs.readdirSync(directory);
      } catch (err     ) {
        if (err && err.code === "ENOENT") continue;
        throw new Error(`template_library_corrupt: ${err && err.message ? err.message : err}`);
      }
      for (const name of names) {
        if (typeof name !== "string" || !name.endsWith(".json")) continue;
        const templateId = name.slice(0, -5);
        if (isValidLiveuiLibraryItemId(templateId)) ids.add(templateId);
      }
    }
    return ids;
  }

  function readDeliveredValues(templateId     , query      = {}) {
    if (query && (typeof query.owner === "string" || query.owner === null)) {
      return readLiveuiTemplateValues(libraryRoot, templateId, { owner: query.owner });
    }
    return findLiveuiTemplateValues(libraryRoot, templateId, {
      resultId: query && typeof query.resultId === "string" ? query.resultId : null,
    });
  }

  function writeDeliveredValues(templateId     , delivery      = {}) {
    const stored      = readRecord(templateId);
    if (stored.status !== "accepted") return stored;
    const checked      = checkDeliveredTemplateValues(stored.envelope.inputs, delivery && delivery.values);
    if (!checked.ok) {
      return {
        status: "rejected",
        code: checked.code,
        message: checked.detail,
        templateId,
        ...(checked.key ? { key: checked.key } : {}),
      };
    }
    const deliveredAtMs = delivery && typeof delivery.deliveredAtMs === "number" &&
      Number.isFinite(delivery.deliveredAtMs)
      ? delivery.deliveredAtMs
      : Date.now();
    const heading = delivery && typeof delivery.heading === "string"
      ? Array.from(delivery.heading.replace(/\s+/g, " ").trim())
        .slice(0, LIVEUI_TEMPLATE_VALUES_HEADING_MAX).join("").trim()
      : "";
    const owner = delivery && typeof delivery.owner === "string" ? delivery.owner : null;
    const resultId = delivery && typeof delivery.resultId === "string" ? delivery.resultId : null;
    const fit = checked.fit;
    const fixes = validTaskFixes(fit.fixes, Object.keys(checked.values));

    const unchecked      = deliveredTemplateUnchecked(stored.envelope, checked.values,
      readLiveuiTemplateValues(libraryRoot, templateId, { owner }), { deliveredAtMs, resultId,

        reasons: taskFitReasons(fit, delivery && delivery.reasons ? delivery.reasons
          : taskToolReasons(checked.values, delivery && delivery.toolFailures, fit.unfit)),
        fixesBytes: fixes ? JSON.stringify(fixes).length : 0 });
    if (unchecked.status === "rejected") return { status: "rejected", code: unchecked.code, templateId };
    const file = {
      schemaVersion: LIVEUI_TEMPLATE_VALUES_SCHEMA_VERSION,
      templateId,
      digest: stored.envelope.digest,
      deliveredAtMs,
      ...(resultId ? { resultId } : {}),
      ...(heading ? { heading } : {}),
      values: checked.values,
      ...(unchecked.unchecked ? { unchecked: unchecked.unchecked } : {}),
      ...(unchecked.unchecked ? { seenAtMs: unchecked.seenAtMs } : {}),
      ...(fixes ? { fixes } : {}),
    };
    writeLiveuiTemplateValues(libraryRoot, templateId, file, {
      manageLibraryDir: !(typeof opts.libraryDir === "string" && opts.libraryDir.trim()),
      owner,
    });

    const taskId = typeof owner === "string" && owner.startsWith("task.") ? owner.slice("task.".length) : null;
    if (taskId) {
      createTaskFitStore({ libraryDir: libraryRoot }).write(taskFitRecordFor({ taskId, deliveryId: resultId,
        source: delivery && delivery.source === "run" ? "run" : "schedule", atMs: deliveredAtMs, inputs: stored.envelope.inputs,
        look: isOcuclawCardId(templateId) ? templateId : null, values: checked.values, fixes, unchecked: unchecked.unchecked }));
    }
    const fitLine = taskFitLog(fit);
    if (fitLine) opts.logger?.info?.(`[liveui-template] fitted values template=${templateId} owner=${owner || "-"} ${fitLine}`);
    return {
      status: "written",
      templateId,
      digest: file.digest,
      deliveredAtMs,
      ...(owner ? { owner } : {}),
      ...(checked.dropped.length > 0 ? { dropped: checked.dropped } : {}),

      ...(unchecked.unchecked ? { unchecked: Object.keys(unchecked.unchecked) } : {}),
      ...(unchecked.unchecked && Object.values(checked.values).every((value) => value === null) ? { allUnchecked: true } : {}),

      values: checked.values,
      ...(fixes ? { fixes } : {}),
      ...(fit.unfit.length ? { unfit: fit.unfit } : {}),
      ...(fit.missing.length ? { missing: fit.missing } : {}),
    };
  }

  function clearDeliveredValues(templateId     , owner      = null) {
    return removeLiveuiTemplateValues(libraryRoot, templateId, { owner: typeof owner === "string" ? owner : null });
  }

  return {
    libraryDir,
    libraryDirV2: templateV2Dir,

    save(input     , options      = {}) {
      const helperValidation      = validateHelperOf(options.helperOf);
      if (helperValidation.status !== "accepted") return helperValidation;
      if (input && typeof input === "object" && input.schemaVersion === LIVEUI_TEMPLATE_V2_SCHEMA_VERSION) {
        const built = v2FromEnvelope(input, options, helperValidation.helperOf);
        if (built.status !== "accepted") return built;
        return idClash(built.record.templateId) || writeRecord(built.record, options);
      }
      const checked = validateV1Artifact(input, options);
      if (checked.status !== "accepted") return checked;
      const record = v2FromV1Artifact(checked.artifact, checked.persistedSpec, helperValidation.helperOf);
      return idClash(record.templateId) || writeRecord(record, options);
    },
    read(templateId     ) {
      return readRecord(templateId);
    },

    list() {
      const templates      = [];
      for (const templateId of readIds()) {
        let loaded;
        try {
          loaded = loadRecord(templateId);
        } catch (_) {
          continue;
        }
        if (!loaded || !loaded.record) continue;
        const record = loaded.record;
        templates.push({ templateId: record.templateId, name: record.name, digest: record.digest });
      }
      templates.sort((a     , b     ) => a.templateId.localeCompare(b.templateId));
      return { status: "accepted", templates };
    },
    listItems(options      = {}) {
      return library.listItems(options);
    },
    readDeliveredValues,
    writeDeliveredValues,
    clearDeliveredValues,

    clearOwnerValues(owner     ) {
      return removeLiveuiTemplateValuesOwner(libraryRoot, owner);
    },

    applyTaskResult(result     , options      = {}) {
      return applyTaskResultToTemplateValues(result, {
        library: { writeDeliveredValues, clearDeliveredValues },
        ...(typeof options.resolveLook === "function" ? { resolveLook: options.resolveLook } : {}),
        ...(typeof options.resolveTask === "function" ? { resolveTask: options.resolveTask } : {}),
      });
    },
    delete(templateId     , options      = {}) {
      if (!isValidLiveuiLibraryItemId(templateId)) {
        return rejected("template_id_invalid", "templateId is invalid");
      }
      return library.deleteItem("template", templateId, options);
    },

    deleteSavedCard(appId     ) {
      if (!isValidLiveuiLibraryItemId(appId)) {
        return rejected("item_unavailable", "Library item is unavailable");
      }
      const current      = library.loadItem("app", appId);
      const listed = current && current.status === "accepted"
        ? true
        : (library.listItems().items || []).some(
          (item     ) => item && item.itemType === "app" && item.itemId === appId,
        );
      if (!listed) return rejected("item_unavailable", "Library item is unavailable");
      return library.deleteItem("app", appId, {
        expectedDigest: current && current.status === "accepted" ? current.record.digest : undefined,
      });
    },

    renameTemplateRecord(templateId     , name     , options      = {}) {
      if (!isValidLiveuiLibraryItemId(templateId)) {
        return rejected("template_id_invalid", "templateId is invalid");
      }
      if (typeof name !== "string" || !name.trim() || name.length > TEMPLATE_NAME_MAX) {
        return rejected("template_name_invalid", `name must be 1-${TEMPLATE_NAME_MAX} characters`);
      }
      const loaded = loadRecord(templateId);
      if (!loaded) return rejected("template_not_found", `template not found: ${templateId}`);
      if (loaded.rejected) return loaded.rejected;
      const { digest: _digest, ...rest } = loaded.record;
      const saved = library.saveItem("template", templateId, { ...rest, name: name.trim() }, {
        ...(options.expectedDigest === undefined ? {} : { expectedDigest: options.expectedDigest }),
      });
      if (saved.status !== "saved") return saved;
      return acceptedRecord("saved", saved.record);
    },
  };
}

function composedRefreshProblem(refresh     , inputs       )                {
  if (refresh === undefined) return null;
  if (!refresh.recipe || typeof refresh.recipe !== "object" || Array.isArray(refresh.recipe)) {
    return "refresh.recipe must be an object";
  }
  const targets = refresh.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets) || Object.keys(targets).length === 0) {
    return "refresh.targets must map input keys to JSON Pointers";
  }
  const declared = new Set(inputs.map((input     ) => input.key));
  for (const [key, pointer] of Object.entries(targets)) {
    if (!declared.has(key)) return `refresh.targets.${key} names no declared input`;
    if (typeof pointer !== "string" || (pointer !== "" && !pointer.startsWith("/"))) {
      return `refresh.targets.${key} is not a JSON Pointer`;
    }
  }
  if (refresh.onError !== undefined && !["keep_last", "show_error", "stop"].includes(refresh.onError)) {
    return "refresh.onError must be keep_last, show_error or stop";
  }
  return null;
}

async function dispatchLiveuiTemplateOperation(
  handler     ,
  args     ,
  render     ,
  options                   = {},
) {
  const operation = args && typeof args.operation === "string" ? args.operation : "";

  const shaped = (result     ) => {
    if (!result || typeof result !== "object" || result.envelope === undefined) return result;
    const { envelope, ...rest } = result;
    return options.v2 ? { ...rest, template: envelope } : rest;
  };
  if (operation === "save") return shaped(handler.saveTemplate(args.template, {
    ...(args.expectedDigest === undefined ? {} : { expectedDigest: args.expectedDigest }),
  }));
  if (operation === "read") return shaped(handler.readTemplate(args.templateId));
  if (operation === "list") return handler.listTemplates();
  if (operation === "list_library") return handler.listLibrary();
  if (operation === "schema") {
    return {
      status: "accepted",
      templateSchema: options.v2 ? LIVEUI_TEMPLATE_V2_SAVE_SCHEMA : templateArtifactSchema,
    };
  }
  if (operation === "render") {
    const stored = handler.readTemplate(args.templateId);
    if (stored.status !== "accepted") return stored;
    return render(stored.template, args.values, stored.envelope);
  }
  return rejected(
    "template_operation_invalid",
    "operation must be save, read, list, list_library, render, or schema",
  );
}

async function runLiveuiTemplateRenderLifecycle(opts     ) {
  const previousDepth = opts.depthBySession.get(opts.sessionKey) || 0;
  const depth = opts.nextDepth(opts.sessionKey);
  try {
    return await opts.renderStoredTemplate({
      template: opts.template,
      values: opts.values,

      ...(typeof opts.title === "string" && opts.title ? { title: opts.title } : {}),

      ...(opts.more && typeof opts.more === "object" && Object.keys(opts.more).length ? { more: opts.more } : {}),
      sessionKey: opts.sessionKey,
      depth,
      signal: opts.signal,
      onOpened: opts.onOpened,
      wearerInitiated: opts.wearerInitiated === true,

      requireViewedSession: opts.requireViewedSession === true,

      origin: opts.origin,
    });
  } catch (err) {
    if (!opts.restoreDepth) {
      const failedDepth = opts.depthBySession.get(opts.sessionKey) || 0;
      opts.depthBySession.set(opts.sessionKey, Math.max(0, failedDepth - 1));
    }
    throw err;
  } finally {
    if (opts.restoreDepth) {
      if (previousDepth > 0) opts.depthBySession.set(opts.sessionKey, previousDepth);
      else opts.depthBySession.delete(opts.sessionKey);
    }
  }
}

function liveuiDeliveredOpen(handler     , stored     , nowMs         = Date.now(), resultId      = null) {
  try {
    const envelope = stored && stored.envelope;
    if (!envelope || typeof handler.readDeliveredTemplateValues !== "function") return null;
    const file = handler.readDeliveredTemplateValues(
      envelope.templateId,
      typeof resultId === "string" && resultId ? { resultId } : {},
    );
    const passive = passiveTemplateValues(envelope, file);
    if (!passive) return null;

    const { values, titleLine } = templateUncheckedOpen(envelope, file, passive, nowMs);

    const more                         = {};
    for (const [key, fix] of Object.entries(validTaskFixes(file.fixes, Object.keys(values)) || {})) {
      if (fix.hidden && Array.isArray(values[key])) more[key] = fix.hidden;
    }
    return {
      values,
      ...(Object.keys(more).length ? { more } : {}),
      title: titleLine ? liveuiUncheckedTitle(titleLine)
        : liveuiDeliveredTitle(file.heading, String(envelope.name || ""), file.deliveredAtMs, nowMs),
      deliveredAtMs: file.deliveredAtMs,
      ...(typeof file.resultId === "string" ? { resultId: file.resultId } : {}),
    };
  } catch (_) {
    return null;
  }
}

function createLiveuiGlassesLibraryController(opts     ) {
  const handler = opts && opts.handler;
  if (!handler) throw new Error("LiveUI glasses Library requires a handler");
  const injectedTaskRunController = opts && opts.taskRunController;
  const resolveExecutorState = opts && typeof opts.resolveExecutorState === "function"
    ? opts.resolveExecutorState
    : null;

  const getActiveTemplateSurface = () =>
    activeLibraryTemplateSurfaceByHandler.get(handler) || null;
  const setActiveTemplateSurface = (value     ) => {
    if (value) activeLibraryTemplateSurfaceByHandler.set(handler, value);
    else activeLibraryTemplateSurfaceByHandler.delete(handler);
  };

  function normalizeSessionKey(rawSessionKey     ) {
    return typeof opts.normalizeSessionKey === "function"
      ? opts.normalizeSessionKey(rawSessionKey)
      : rawSessionKey;
  }

  function resolveTaskRunController() {
    return typeof injectedTaskRunController === "function"
      ? injectedTaskRunController()
      : injectedTaskRunController;
  }

  function withRunningTasks(snapshot     ) {
    const tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const controller = resolveTaskRunController();
    const active = controller && typeof controller.activeRun === "function"
      ? projectLiveuiTaskRunForPhone(controller.activeRun())
      : null;
    return {
      ...snapshot,
      tasks: tasks.map((task     ) => {
        if (!task || typeof task !== "object") return task;
        const running = active && active.taskId === task.taskId
          ? { since: active.since, executor: active.executor, runId: active.runId }
          : null;
        return { ...task, running };
      }),
    };
  }

  return {
    listLibrary() {
      const result = handler.listLibrary({ executorStateProvider: resolveExecutorState });
      const organizationState = typeof handler.getLibraryOrganization === "function"
        ? handler.getLibraryOrganization()
        : null;
      return projectLiveuiLibraryForGlasses(
        result && result.items,
        organizationState && organizationState.organization,
      );
    },

    onTaskResultDelivered(result     ) {
      if (typeof handler.onTaskResultDelivered !== "function") {
        return { status: "skipped", reason: "item_unavailable" };
      }
      return handler.onTaskResultDelivered(result);
    },

    listTasksForPhone() {
      if (typeof handler.listTasksForPhone !== "function") {
        return {
          tasks: [],
          templates: [],
          invalid: [],
          organization: { schemaVersion: 1, order: [], hidden: [], digest: "" },
        };
      }
      return withRunningTasks(handler.listTasksForPhone(resolveExecutorState));
    },

    updateTaskExecutor(taskId     , executor     ) {
      if (typeof handler.updateTaskExecutor !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      const result = handler.updateTaskExecutor(taskId, executor);
      if (!result || result.status !== "saved") {
        return {
          taskId,
          status: "rejected",
          code: result && typeof result.code === "string" ? result.code : "task_executor_update_failed",
        };
      }
      return { taskId, status: "accepted" };
    },

    updateTaskSettingValues(taskId     , values     , options      = {}) {
      if (typeof handler.updateTaskSettingValues !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      const result = handler.updateTaskSettingValues(taskId, values, options);
      if (!result || result.status !== "saved") {
        return {
          taskId,
          status: "rejected",
          code: result && typeof result.code === "string"
            ? result.code
            : "task_setting_values_update_failed",
          ...(result && Array.isArray(result.invalid) ? { invalid: result.invalid } : {}),
        };
      }
      return {
        taskId,
        status: "accepted",
        ...(result.task && typeof result.task === "object" ? { task: result.task } : {}),
      };
    },

    updateTaskPreferredTemplate(params     ) {
      if (typeof handler.setTaskPreferredTemplate !== "function") {
        return {
          taskId: params && typeof params.taskId === "string" ? params.taskId : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return handler.setTaskPreferredTemplate(
        params.taskId,
        params.templateId,
        { expectedDigest: params.expectedDigest },
      );
    },

    listTaskRunRecords(taskId     ) {
      return typeof handler.listTaskRunRecords === "function"
        ? handler.listTaskRunRecords(taskId)
        : [];
    },

    appendTaskRunRecord(record     ) {
      return typeof handler.appendTaskRunRecord === "function"
        ? handler.appendTaskRunRecord(record)
        : null;
    },

    deliveryStateOf(surfaceId     ) {
      return typeof handler.deliveryStateOf === "function"
        ? handler.deliveryStateOf(surfaceId)
        : null;
    },

    reviewTask(params     ) {
      if (typeof handler.reviewTask !== "function") {
        return {
          taskId: params && typeof params.taskId === "string" ? params.taskId : "",
          action: params && typeof params.action === "string" ? params.action : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return handler.reviewTask(params);
    },

    getLiveuiPrefs() {
      if (typeof handler.liveuiPrefs !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return handler.liveuiPrefs();
    },

    setLiveuiPrefs(patch     ) {
      if (typeof handler.setLiveuiPrefs !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return handler.setLiveuiPrefs(patch);
    },

    getLiveuiStatus() {
      if (typeof handler.liveuiStatus !== "function") return null;
      return handler.liveuiStatus();
    },

    liveuiGrantsSnapshot() {
      if (typeof handler.liveuiGrantsSnapshot !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return handler.liveuiGrantsSnapshot();
    },

    liveuiHostCheck() {
      if (typeof handler.liveuiHostCheck !== "function") return null;
      return handler.liveuiHostCheck();
    },

    onLiveuiGrantsChanged(listener     ) {
      if (typeof handler.onLiveuiGrantsChanged !== "function") return () => {};
      return handler.onLiveuiGrantsChanged(listener);
    },

    onLiveuiTasksChanged(listener     ) {
      if (typeof handler.onLiveuiTasksChanged !== "function") return () => {};
      return handler.onLiveuiTasksChanged(listener);
    },

    applyLiveuiGrantIntent(intent     ) {
      if (typeof handler.applyLiveuiGrantIntent !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return handler.applyLiveuiGrantIntent(intent);
    },

    grantLiveuiSite(host     ) {
      if (typeof handler.grantLiveuiSite !== "function") return { ok: false, code: "item_unavailable" };
      return handler.grantLiveuiSite(host);
    },

    programCardFeedOutcomes(request     ) {
      if (typeof handler.programCardFeedOutcomes !== "function") return Promise.resolve(null);
      return handler.programCardFeedOutcomes(request);
    },

    programCardFeedHealth(card     ) {
      if (typeof handler.programCardFeedHealth !== "function") return [];
      return handler.programCardFeedHealth(card);
    },

    settleProgramCardFeeds(request     ) {
      if (typeof handler.settleProgramCardFeeds !== "function") return Promise.resolve(null);
      return handler.settleProgramCardFeeds(request);
    },

    updateTaskContext(taskId     , context     ) {
      if (typeof handler.updateTaskContext !== "function") {
        return {
          taskId: typeof taskId === "string" ? taskId : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return handler.updateTaskContext(taskId, context);
    },

    organizeLibrary(params     ) {
      if (typeof handler.organizeLibrary !== "function") {
        return {
          action: params && typeof params.action === "string" ? params.action : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return handler.organizeLibrary(params);
    },

    async openLibraryItem(params     ) {
      if (isLiveuiSwitchedOff(handler)) return liveuiDisabledResult();
      const itemType = params && typeof params.itemType === "string" ? params.itemType : "";
      const itemId = params && typeof params.itemId === "string" ? params.itemId : "";
      if (itemType === "task") {
        const taskRunController = params && params.taskRunController
          ? params.taskRunController
          : resolveTaskRunController();
        if (!taskRunController || typeof taskRunController.launchTask !== "function") {
          return { itemType, itemId, status: "rejected", code: "item_unavailable" };
        }
        return taskRunController.launchTask({
          taskId: itemId,
          clientId: params && typeof params.clientId === "string" ? params.clientId : "",
          origin: params && params.origin,
        });
      }
      if (itemType === "app") {
        return { itemType, itemId, status: "rejected", code: "item_unavailable" };
      }
      if (itemType !== "template") {
        return { itemType, itemId, status: "rejected", code: "item_type_unknown" };
      }

      const stored = handler.readTemplate(itemId);
      if (!stored || stored.status !== "accepted") {
        return {
          itemType,
          itemId,
          status: "rejected",
          code: stored && typeof stored.code === "string" ? stored.code : "template_not_found",
        };
      }

      const delivered = liveuiDeliveredOpen(
        handler,
        stored,
        typeof opts.now === "function" ? opts.now() : Date.now(),
        params && typeof params.resultId === "string" ? params.resultId : null,
      );

      const sessionKey = normalizeSessionKey(params.sessionKey);
      try {
        const previousSurface = getActiveTemplateSurface();
        if (
          previousSurface &&
          typeof handler.releaseLibraryTemplateSurface === "function"
        ) {
          handler.releaseLibraryTemplateSurface(previousSurface.surfaceId, {
            result: "preempted",
            origin: "system",
            reason: "library_template_reopen",
          });
          if (getActiveTemplateSurface() === previousSurface) setActiveTemplateSurface(null);
        }
        let markOpened = (_details     ) => {};
        let openedSurfaceId      = null;
        const opened = new Promise((resolve) => {
          markOpened = resolve;
        });
        const lifecycle = runLiveuiTemplateRenderLifecycle({
          template: stored.template,
          ...(delivered ? { values: delivered.values, title: delivered.title } : {}),
          ...(delivered && delivered.more ? { more: delivered.more } : {}),
          sessionKey,
          signal: params.signal,
          depthBySession: opts.depthBySession,
          nextDepth: opts.nextDepth,
          restoreDepth: true,
          renderStoredTemplate: (renderInput     ) => handler.renderStoredTemplate(renderInput),
          wearerInitiated: params && params.origin === "glasses",
          origin: "task",
          onOpened: (details     ) => {
            openedSurfaceId = details && details.surfaceId;
            setActiveTemplateSurface({
              itemId,
              sessionKey,
              surfaceId: openedSurfaceId,
            });
            markOpened?.(details);
          },
        });

        const ended = lifecycle.then(
          (result     ) => {

            if (isTerminalOutcome(result && result.outcome)) {
              const details = getActiveTemplateSurface();
              if (details && details.surfaceId === openedSurfaceId) {
                setActiveTemplateSurface(null);
              }
            }
            return { kind: "ended", result, error: null, details: null };
          },
          (error     ) => {
            const details = getActiveTemplateSurface();
            if (details && details.surfaceId === openedSurfaceId) {
              setActiveTemplateSurface(null);
            }
            return { kind: "failed", result: null, error, details: null };
          },
        );
        const first = await Promise.race([
          opened.then((details     ) => ({ kind: "opened", result: null, error: null, details })),
          ended,
        ]);
        if (first.kind === "failed") throw first.error;
        if (first.kind !== "opened") {
          const error = Object.assign(
            new Error("Template lifecycle ended before its first render was sent"),
            { code: "template_open_failed" },
          );
          throw error;
        }
        return { itemType, itemId, status: "accepted" };
      } catch (err     ) {
        return {
          itemType,
          itemId,
          status: "rejected",
          code: err && typeof err.code === "string" ? err.code : "template_open_failed",
        };
      }
    },

    readTaskSchedule(taskId     ) {
      return typeof handler.readTaskSchedule === "function" ? handler.readTaskSchedule(taskId)
        : { status: "rejected", code: "task_schedule_unavailable" };
    },

    readTask(taskId     ) {
      return typeof handler.readTask === "function" ? handler.readTask(taskId)
        : { status: "rejected", code: "task_not_found" };
    },
    taskForTaskResult(result     ) {
      return typeof handler.taskForTaskResult === "function" ? handler.taskForTaskResult(result) : null;
    },

    taskTestScheduler() {
      return typeof handler.taskTestScheduler === "function" ? handler.taskTestScheduler() : null;
    },
    readTemplate(templateId     ) {
      return handler.readTemplate(templateId);
    },
    saveTemplate(template     , options     ) {
      return handler.saveTemplate(template, options);
    },
    writeDeliveredTemplateValues(templateId     , delivery     ) {
      return handler.writeDeliveredTemplateValues(templateId, delivery);
    },
    readTaskForRun(taskId     ) {
      if (typeof handler.readTask !== "function") {
        return { status: "rejected", code: "task_not_found" };
      }
      const loaded = handler.readTask(taskId);
      if (!loaded || loaded.status !== "accepted" || !loaded.task) return loaded;
      const approved = loaded.task.versions && loaded.task.versions.approved;
      return {
        status: "accepted",
        task: {
          taskId: loaded.task.taskId,
          versions: approved ? { approved } : {},
          ...(loaded.task.settingValues && typeof loaded.task.settingValues === "object"
            ? { settingValues: { ...loaded.task.settingValues } }
            : {}),
          ...(typeof loaded.task.preferredTemplateId === "string"
            ? { preferredTemplateId: loaded.task.preferredTemplateId }
            : {}),
        },
      };
    },

    setTaskLook(taskId     , look     ) {
      return typeof handler.setTaskLook === "function" ? handler.setTaskLook(taskId, look)
        : { status: "rejected", code: "task_schedule_unavailable" };
    },

    reconcileTaskSchedule(taskId     ) {
      return typeof handler.reconcileTaskSchedule === "function"
        ? handler.reconcileTaskSchedule(taskId)
        : null;
    },

    retryUnsyncedTaskSchedules() {
      return typeof handler.retryUnsyncedTaskSchedules === "function"
        ? handler.retryUnsyncedTaskSchedules()
        : null;
    },

    resolveTemplateHint(templateId     ) {
      return typeof handler.resolveTemplateHint === "function"
        ? handler.resolveTemplateHint(templateId)
        : null;
    },

    sessionForSurface(surfaceId     ) {
      return typeof handler.sessionForSurface === "function"
        ? handler.sessionForSurface(surfaceId)
        : null;
    },

    hasClientReceipt(surfaceId     , seq     ) {
      if (
        typeof handler.deliveryStateOf !== "function" ||
        typeof handler.hasClientReceipt !== "function"
      ) return false;
      const delivery = handler.deliveryStateOf(surfaceId);
      return !!(
        delivery &&
        delivery.surfaceUuid &&
        handler.hasClientReceipt(delivery.surfaceUuid, seq)
      );
    },
  };
}

module.exports = { LIVEUI_TEMPLATE_LIBRARY_SCHEMA_VERSION, LIVEUI_TEMPLATE_LIBRARY_DIRNAME, LIVEUI_TEMPLATE_TOOL_NAME, LIVEUI_TEMPLATE_TOOL_DESCRIPTION, liveuiTemplateToolParametersSchema, liveuiTemplateLeanToolParametersSchema, liveuiTemplateToolParametersSchemaFor, resolveLiveuiTemplateLibraryDir, createLiveuiTemplateLibrary, dispatchLiveuiTemplateOperation, runLiveuiTemplateRenderLifecycle, liveuiDeliveredOpen, createLiveuiGlassesLibraryController };
