const fs = require("node:fs");

const path = require("node:path");
const { LIVEUI_LIBRARY_ITEM_TYPES, canonicalSerialize, createLiveuiLibrary, isValidLiveuiLibraryItemId, projectLiveuiLibraryForGlasses, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { listKindItemSchemas, validateKindItemAgainstGrammar } = require("./glasses-ui-descriptors.cjs");
const { refreshSchemaForToolParams } = require("./glasses-ui-refresh-schema.cjs");
const { projectLiveuiTaskRunForPhone } = require("./glasses-ui-task-run.cjs");
const { isLiveuiSwitchedOff, liveuiDisabledResult } = require("./glasses-ui-prefs.cjs");
const { GLASSES_UI_LIMITS, LIVEUI_TEMPLATE_RENDER_TIMEOUT_MAX_MS } = require("./glasses-ui-limits.cjs");
const { LIVEUI_TEMPLATE_SLOT_LIST_MAX, LIVEUI_TEMPLATE_SLOT_MAX, LIVEUI_TEMPLATE_SLOT_TEXT_MAX, copyLiveuiStaticJson, fillLiveuiTemplate, previewLiveuiTemplatePresentation, sampleLiveuiTemplateValues, validateLiveuiTemplateSlotContract } = require("./glasses-ui-template-slots.cjs");

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
};

const engineFieldsSchema = {
  type: "object",
  properties: engineFieldProperties,
  additionalProperties: false,
};

const assetProperties = {
  template: { type: "string", enum: ["image_caption"] },
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
          { type: "array", items: { type: "string" } },
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

function propertyKeys(schema) {
  return new Set(Object.keys(schema.properties || {}));
}

const TOP_LEVEL_KEYS = propertyKeys(templateArtifactSchema);
const ENGINE_FIELD_KEYS = propertyKeys(engineFieldsSchema);
const ASSET_KEYS = propertyKeys(templateArtifactProperties.assets);
const TEMPLATE_NAME_MAX = 120;
const TEMPLATE_MAX_BYTES = 256 * 1024;

function rejected(code, message) {
  return { status: "rejected", code, message };
}

function validateHelperOf(value) {
  if (value === undefined) return { status: "accepted", helperOf: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(value, "taskId") ||
      !isValidLiveuiLibraryItemId(value.taskId)) {
    return rejected("template_helper_invalid", "helperOf must be exactly { taskId }");
  }
  return { status: "accepted", helperOf: { taskId: value.taskId } };
}

function unknownKey(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).find((key) => !allowed.has(key)) || null;
}

function firstEngineDroppedPath(input, normalized, currentPath = "recipe") {
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

function resolveLiveuiTemplateLibraryDir(libraryDir) {
  if (typeof libraryDir === "string" && libraryDir.trim()) return path.resolve(libraryDir.trim());
  return path.join(resolveLiveuiLibraryRoot(undefined), LIVEUI_TEMPLATE_LIBRARY_DIRNAME);
}

function validateEnvelope(input) {
  let template;
  try {
    template = copyLiveuiStaticJson(input);
  } catch (err) {
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
      "templateId must be 1-64 lowercase letters, digits, dot, underscore, or hyphen",
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
  const sections = [
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

function createLiveuiTemplateLibrary(opts = {}) {
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

  function recordPath(templateId) {
    return path.join(libraryDir, `${templateId}.json`);
  }

  function loadRecord(templateId) {
    if (!fs.existsSync(recordPath(templateId))) return null;
    const loaded = library.loadItem("template", templateId);
    if (loaded.status === "accepted") return loaded.record;
    if (loaded.reason === "library_digest_mismatch") {
      throw new Error(`template_library_corrupt: digest mismatch for ${templateId}`);
    }
    throw new Error(`template_library_corrupt: invalid record ${templateId}`);
  }

  function readRecord(templateId) {
    if (!isValidLiveuiLibraryItemId(templateId)) {
      return rejected("template_id_invalid", "templateId is invalid");
    }
    const record = loadRecord(templateId);
    if (!record) return rejected("template_not_found", `template not found: ${templateId}`);
    return { status: "accepted", template: record };
  }

  return {
    libraryDir,
    save(input, options = {}) {
      const helperValidation = validateHelperOf(options.helperOf);
      if (helperValidation.status !== "accepted") return helperValidation;
      const envelope = validateEnvelope(input);
      if (envelope.status !== "accepted") return envelope;
      const artifact = envelope.template;
      const hasSlotContract = artifact.slots !== undefined || artifact.presentations !== undefined;
      const sampleValues = hasSlotContract ? sampleLiveuiTemplateValues(artifact) : {};
      const filled = hasSlotContract
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
      if (!validation || validation.ok !== true || !validation.normalizedSpec) {
        const first = validation && Array.isArray(validation.errors) ? validation.errors[0] : null;
        return rejected(
          first && first.code ? first.code : "template_spec_invalid",
          first && first.message ? first.message : "template spec failed LiveUI Engine validation",
        );
      }
      if (artifact.recipe !== undefined) {
        const droppedPath = firstEngineDroppedPath(
          artifact.recipe,
          validation.normalizedSpec.refresh,
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
      const digestInput = {
        schemaVersion: artifact.schemaVersion,
        templateId: artifact.templateId,
        name: artifact.name.trim(),
        defaults: artifact.defaults || {},
        fields: artifact.fields,
        assets: artifact.assets || {},
        ...(artifact.slots === undefined ? {} : { slots: artifact.slots }),
        ...(artifact.presentations === undefined
          ? {}
          : { presentations: artifact.presentations }),
        ...(helperValidation.helperOf === undefined
          ? {}
          : { helperOf: helperValidation.helperOf }),
        ...(validation.normalizedSpec.refresh === undefined
          ? {}
          : { recipe: validation.normalizedSpec.refresh }),
        spec: validation.normalizedSpec,
      };

      const saved = library.saveItem("template", artifact.templateId, digestInput, options);
      if (saved.status !== "saved") return saved;
      return { status: "saved", template: saved.record };
    },
    read(templateId) {
      return readRecord(templateId);
    },
    list() {
      let names;
      try {
        names = fs.readdirSync(libraryDir);
      } catch (err) {
        if (err && err.code === "ENOENT") return { status: "accepted", templates: [] };
        throw new Error(`template_library_corrupt: ${err && err.message ? err.message : err}`);
      }
      const templates = names
        .filter((name) => typeof name === "string" && name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .filter((templateId) => isValidLiveuiLibraryItemId(templateId))
        .map((templateId) => loadRecord(templateId))
        .map((entry) => ({
          templateId: entry.templateId,
          name: entry.name,
          digest: entry.digest,
        }))
        .sort((a, b) => a.templateId.localeCompare(b.templateId));
      return { status: "accepted", templates };
    },
    listItems(options = {}) {
      return library.listItems(options);
    },
    delete(templateId, options = {}) {
      if (!isValidLiveuiLibraryItemId(templateId)) {
        return rejected("template_id_invalid", "templateId is invalid");
      }
      return library.deleteItem("template", templateId, options);
    },
  };
}

async function dispatchLiveuiTemplateOperation(handler, args, render) {
  const operation = args && typeof args.operation === "string" ? args.operation : "";
  if (operation === "save") return handler.saveTemplate(args.template, {
    ...(args.expectedDigest === undefined ? {} : { expectedDigest: args.expectedDigest }),
  });
  if (operation === "read") return handler.readTemplate(args.templateId);
  if (operation === "list") return handler.listTemplates();
  if (operation === "list_library") return handler.listLibrary();
  if (operation === "render") {
    const stored = handler.readTemplate(args.templateId);
    if (stored.status !== "accepted") return stored;
    return render(stored.template, args.values);
  }
  return rejected(
    "template_operation_invalid",
    "operation must be save, read, list, list_library, or render",
  );
}

async function runLiveuiTemplateRenderLifecycle(opts) {
  const previousDepth = opts.depthBySession.get(opts.sessionKey) || 0;
  const depth = opts.nextDepth(opts.sessionKey);
  try {
    return await opts.renderStoredTemplate({
      template: opts.template,
      values: opts.values,
      sessionKey: opts.sessionKey,
      depth,
      signal: opts.signal,
      onOpened: opts.onOpened,
      wearerInitiated: opts.wearerInitiated === true,
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

function createLiveuiGlassesLibraryController(opts) {
  const handler = opts && opts.handler;
  if (!handler) throw new Error("LiveUI glasses Library requires a handler");
  const injectedTaskRunController = opts && opts.taskRunController;
  const resolveExecutorState = opts && typeof opts.resolveExecutorState === "function"
    ? opts.resolveExecutorState
    : null;

  const getActiveTemplateSurface = () =>
    activeLibraryTemplateSurfaceByHandler.get(handler) || null;
  const setActiveTemplateSurface = (value) => {
    if (value) activeLibraryTemplateSurfaceByHandler.set(handler, value);
    else activeLibraryTemplateSurfaceByHandler.delete(handler);
  };

  function normalizeSessionKey(rawSessionKey) {
    return typeof opts.normalizeSessionKey === "function"
      ? opts.normalizeSessionKey(rawSessionKey)
      : rawSessionKey;
  }

  function resolveTaskRunController() {
    return typeof injectedTaskRunController === "function"
      ? injectedTaskRunController()
      : injectedTaskRunController;
  }

  function withRunningTasks(snapshot) {
    const tasks = snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    const controller = resolveTaskRunController();
    const active = controller && typeof controller.activeRun === "function"
      ? projectLiveuiTaskRunForPhone(controller.activeRun())
      : null;
    return {
      ...snapshot,
      tasks: tasks.map((task) => {
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

    updateTaskExecutor(taskId, executor) {
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

    updateTaskSettingValues(taskId, values, options = {}) {
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

    updateTaskPreferredTemplate(params) {
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

    listTaskRunRecords(taskId) {
      return typeof handler.listTaskRunRecords === "function"
        ? handler.listTaskRunRecords(taskId)
        : [];
    },

    appendTaskRunRecord(record) {
      return typeof handler.appendTaskRunRecord === "function"
        ? handler.appendTaskRunRecord(record)
        : null;
    },

    deliveryStateOf(surfaceId) {
      return typeof handler.deliveryStateOf === "function"
        ? handler.deliveryStateOf(surfaceId)
        : null;
    },

    reviewTask(params) {
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

    setLiveuiPrefs(patch) {
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

    onLiveuiGrantsChanged(listener) {
      if (typeof handler.onLiveuiGrantsChanged !== "function") return () => {};
      return handler.onLiveuiGrantsChanged(listener);
    },

    applyLiveuiGrantIntent(intent) {
      if (typeof handler.applyLiveuiGrantIntent !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return handler.applyLiveuiGrantIntent(intent);
    },

    updateTaskContext(taskId, context) {
      if (typeof handler.updateTaskContext !== "function") {
        return {
          taskId: typeof taskId === "string" ? taskId : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return handler.updateTaskContext(taskId, context);
    },

    organizeLibrary(params) {
      if (typeof handler.organizeLibrary !== "function") {
        return {
          action: params && typeof params.action === "string" ? params.action : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return handler.organizeLibrary(params);
    },

    async openLibraryItem(params) {
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
        let markOpened = (_details) => {};
        let openedSurfaceId = null;
        const opened = new Promise((resolve) => {
          markOpened = resolve;
        });
        const lifecycle = runLiveuiTemplateRenderLifecycle({
          template: stored.template,
          sessionKey,
          signal: params.signal,
          depthBySession: opts.depthBySession,
          nextDepth: opts.nextDepth,
          restoreDepth: true,
          renderStoredTemplate: (renderInput) => handler.renderStoredTemplate(renderInput),
          wearerInitiated: params && params.origin === "glasses",
          onOpened: (details) => {
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
          (result) => {
            const details = getActiveTemplateSurface();
            if (details && details.surfaceId === openedSurfaceId) {
              setActiveTemplateSurface(null);
            }
            return { kind: "ended", result, error: null, details: null };
          },
          (error) => {
            const details = getActiveTemplateSurface();
            if (details && details.surfaceId === openedSurfaceId) {
              setActiveTemplateSurface(null);
            }
            return { kind: "failed", result: null, error, details: null };
          },
        );
        const first = await Promise.race([
          opened.then((details) => ({ kind: "opened", result: null, error: null, details })),
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
      } catch (err) {
        return {
          itemType,
          itemId,
          status: "rejected",
          code: err && typeof err.code === "string" ? err.code : "template_open_failed",
        };
      }
    },

    readTaskForRun(taskId) {
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

    resolveTemplateHint(templateId) {
      return typeof handler.resolveTemplateHint === "function"
        ? handler.resolveTemplateHint(templateId)
        : null;
    },

    sessionForSurface(surfaceId) {
      return typeof handler.sessionForSurface === "function"
        ? handler.sessionForSurface(surfaceId)
        : null;
    },

    hasClientReceipt(surfaceId, seq) {
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

module.exports = { LIVEUI_TEMPLATE_LIBRARY_SCHEMA_VERSION, LIVEUI_TEMPLATE_LIBRARY_DIRNAME, LIVEUI_TEMPLATE_TOOL_NAME, LIVEUI_TEMPLATE_TOOL_DESCRIPTION, liveuiTemplateToolParametersSchema, resolveLiveuiTemplateLibraryDir, createLiveuiTemplateLibrary, dispatchLiveuiTemplateOperation, runLiveuiTemplateRenderLifecycle, createLiveuiGlassesLibraryController };
