const fs = require("node:fs");

const path = require("node:path");
const { LIVEUI_LIBRARY_ITEM_TYPES, canonicalSerialize, createLiveuiLibrary, isValidLiveuiLibraryItemId, liveuiLibraryDigest, resolveLiveuiLibraryRoot, validateSettingValue: validatePersistedSettingValue } = require("./glasses-ui-library.cjs");
const { abstractSurfaceToTemplate } = require("./glasses-ui-save-ui.cjs");

function validateSettingValue(contractEntry, value) {
  return validatePersistedSettingValue(contractEntry, value);
}

const LIVEUI_TASK_LIBRARY_SCHEMA_VERSION =
  LIVEUI_LIBRARY_ITEM_TYPES.task.schemaVersion;
const LIVEUI_TASK_LIBRARY_DIRNAME = "tasks-v1";
const LIVEUI_TASK_TOOL_NAME = "manage_liveui_tasks";
const LIVEUI_TASK_AMBIGUITY_HINT =
  "Several Tasks match. Ask the user which one in your chat reply; do not render anything until they answer.";

const LIVEUI_TASK_TOOL_DESCRIPTION = [
  "Create a Draft only after the user explicitly asks or accepts an offer to save.",
  "After a useful LiveUI result, offer \"Save this as a Task?\".",
  "Save the exact natural-language request, never a tool plan or tool sequence.",
  "Drafts are phone-only and cannot run until the phone owner approves.",
  "Never replace a pending Draft without asking the user; use replacePendingDraft only after they confirm.",
  "Always pass the digest you read as expectedDigest.",
  "preferredTemplateId is an optional visual hint (a saved Template id). On an approved Task, changing it, the name, or the description creates a pending Draft for phone-owner approval before discovery or execution can use it.",
  "save_ui_as_helper turns the surface currently on the glasses into a hidden reusable helper Template (typed slots, no run content) and sets it as the Task's Preferred Template; use it only when the user asks to save this UI alongside a Task Draft.",
  "When the user asks in ordinary conversation for a job that sounds like a saved Task, call find_tasks first; exactly one match → reuse its request, settings and their current settingValues (and preferredTemplate when present) as helpers and do the work in THIS conversation with your own tools; several matches → ask the user which Task they mean IN YOUR CHAT REPLY and stop; do NOT call render_glasses_ui or paint any picker or surface until the user answers; none → proceed normally; never tell the user a Task \"ran\" — discovery is reuse, not a Task Run.",
].join("\n");

const executorSchema = {
  type: "object",
  required: ["host", "agentId"],
  properties: {
    host: { type: "string", enum: ["openclaw", "hermes"] },
    agentId: { type: "string" },
  },
  additionalProperties: false,
};

const settingSchema = {
  type: "object",
  required: ["key", "type"],
  properties: {
    key: { type: "string" },
    type: { type: "string", enum: ["string", "number", "boolean", "enum"] },
    label: { type: "string", maxLength: 80 },
    required: { type: "boolean" },
    maxLength: { type: "integer", minimum: 1, maximum: 4000 },
    min: { type: "number" },
    max: { type: "number" },
    options: {
      type: "array",
      minItems: 1,
      maxItems: 16,
      items: { type: "string" },
    },
  },
  additionalProperties: false,
};

const liveuiTaskToolParametersSchema = {
  type: "object",
  required: ["operation"],
  properties: {
    operation: {
      type: "string",
      enum: ["create_draft", "update_draft", "read", "list", "find_tasks", "save_ui_as_helper"],
    },
    query: { type: "string" },
    taskId: { type: "string" },
    templateId: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    icon: { type: "string" },
    request: { type: "string" },
    executor: executorSchema,
    context: { type: "string", enum: ["isolated", "current_session"] },
    settings: { type: "array", maxItems: 16, items: settingSchema },
    preferredTemplateId: {
      anyOf: [{ type: "string" }, { type: "null" }],
    },
    expectedDigest: { type: "string" },
    replacePendingDraft: { type: "boolean" },
  },
  additionalProperties: false,
};

const CREATE_KEYS = new Set([
  "taskId",
  "name",
  "description",
  "icon",
  "request",
  "executor",
  "context",
  "settings",
  "preferredTemplateId",
]);
const UPDATE_KEYS = new Set([
  ...CREATE_KEYS,
  "expectedDigest",
  "replacePendingDraft",
]);
const SAVE_UI_KEYS = new Set(["taskId", "expectedDigest", "templateId", "name"]);
const EXECUTOR_KEYS = new Set(["host", "agentId"]);
const SETTING_KEYS = new Set([
  "key",
  "type",
  "label",
  "required",
  "maxLength",
  "min",
  "max",
  "options",
]);
const AUTHORITY_KEYS = ["request", "executor", "context", "settings"];
const APPROVAL_METADATA_KEYS = ["name", "description", "preferredTemplateId"];
const COSMETIC_KEYS = ["icon"];
const OWNER_COSMETIC_KEYS = ["name", "description", "icon"];
const TASK_ICON_RE = /^[a-z0-9._-]+$/;
const TASK_MAX_BYTES = 64 * 1024;
const TASK_MATCH_LIMIT = 5;
const TASK_SEMANTIC_THRESHOLD = 0.5;
const TASK_MATCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "for", "from", "in", "is", "it",
  "my", "of", "on", "or", "please", "that", "the", "this", "to", "with", "you", "your",
]);

const LIVEUI_TASK_ALL_TOOLS_NOTICE =
  "This Task may use any tool available to its Executor; each call still follows that Executor's current approval settings.";
const LIVEUI_TASK_UNKNOWN_APPROVAL_BEHAVIOUR =
  "Tool approvals follow this Agent's current settings.";

function rejected(code, message) {
  return { status: "rejected", code, message };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function unknownKey(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.keys(value).find((key) => !allowed.has(key)) || null;
}

function plainDataCopy(value, state = { keys: 0 }, depth = 0) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (depth > 16) throw new Error("task data is nested too deeply");
  if (Array.isArray(value)) {
    return value.map((entry) => plainDataCopy(entry, state, depth + 1));
  }
  if (!value || typeof value !== "object") {
    throw new Error("task data must contain JSON values only");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("task data must use plain objects");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output = Object.create(null);
  for (const key of Object.keys(descriptors)) {
    state.keys += 1;
    if (state.keys > 512) throw new Error("task data contains too many fields");
    const descriptor = descriptors[key];
    if (!hasOwn(descriptor, "value")) {
      throw new Error(`task field ${JSON.stringify(key)} must be static data`);
    }
    output[key] = plainDataCopy(descriptor.value, state, depth + 1);
  }
  return output;
}

function validateExecutor(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return rejected("task_executor_invalid", "executor must contain host and agentId");
  }
  const extra = unknownKey(input, EXECUTOR_KEYS);
  if (extra) return rejected("task_field_unknown", `unknown executor field: ${extra}`);
  if (!["openclaw", "hermes"].includes(input.host)) {
    return rejected("task_executor_invalid", "executor.host must be openclaw or hermes");
  }
  if (
    typeof input.agentId !== "string" ||
    !input.agentId.trim()
  ) {
    return rejected("task_executor_invalid", "executor.agentId must be a non-empty string");
  }
  return {
    status: "accepted",
    executor: { host: input.host, agentId: input.agentId.trim() },
  };
}

function validateSetting(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return rejected("task_setting_invalid", `settings[${index}] must be an object`);
  }
  const extra = unknownKey(input, SETTING_KEYS);
  if (extra) {
    return rejected("task_setting_field_unknown", `unknown settings[${index}] field: ${extra}`);
  }
  if (!isValidLiveuiLibraryItemId(input.key)) {
    return rejected("task_setting_key_invalid", `settings[${index}].key is invalid`);
  }
  if (input.type === "secret" || input.type === "password") {
    return rejected(
      "task_setting_secret_unsupported",
      "secret and password Task Setting types are not supported in V1",
    );
  }
  if (!["string", "number", "boolean", "enum"].includes(input.type)) {
    return rejected("task_setting_type_invalid", `settings[${index}].type is unsupported`);
  }
  if (
    input.label !== undefined &&
    (typeof input.label !== "string" || input.label.length > 80)
  ) {
    return rejected(
      "task_setting_label_invalid",
      `settings[${index}].label must be at most 80 characters`,
    );
  }
  if (input.required !== undefined && typeof input.required !== "boolean") {
    return rejected("task_setting_required_invalid", `settings[${index}].required must be boolean`);
  }
  if (input.type === "string") {
    if (
      input.maxLength !== undefined &&
      (!Number.isSafeInteger(input.maxLength) || input.maxLength < 1 || input.maxLength > 4000)
    ) {
      return rejected(
        "task_setting_max_length_invalid",
        `settings[${index}].maxLength must be an integer from 1 to 4000`,
      );
    }
  } else if (input.maxLength !== undefined) {
    return rejected(
      "task_setting_field_invalid",
      `settings[${index}].maxLength is only valid for string settings`,
    );
  }
  if (input.type === "number") {
    if (input.min !== undefined && !Number.isFinite(input.min)) {
      return rejected("task_setting_range_invalid", `settings[${index}].min must be finite`);
    }
    if (input.max !== undefined && !Number.isFinite(input.max)) {
      return rejected("task_setting_range_invalid", `settings[${index}].max must be finite`);
    }
    if (input.min !== undefined && input.max !== undefined && input.min > input.max) {
      return rejected("task_setting_range_invalid", `settings[${index}].min exceeds max`);
    }
  } else if (input.min !== undefined || input.max !== undefined) {
    return rejected(
      "task_setting_field_invalid",
      `settings[${index}].min and max are only valid for number settings`,
    );
  }
  if (input.type === "enum") {
    if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 16) {
      return rejected(
        "task_setting_options_invalid",
        `settings[${index}].options must contain 1-16 entries`,
      );
    }
    if (
      input.options.some(
        (option) =>
          typeof option !== "string" || option.length > 64,
      )
    ) {
      return rejected(
        "task_setting_options_invalid",
        `settings[${index}].options must be strings up to 64 characters`,
      );
    }
  } else if (input.options !== undefined) {
    return rejected(
      "task_setting_field_invalid",
      `settings[${index}].options is only valid for enum settings`,
    );
  }
  const setting = { key: input.key, type: input.type };
  for (const key of ["label", "required", "maxLength", "min", "max", "options"]) {
    if (input[key] !== undefined) setting[key] = input[key];
  }
  return { status: "accepted", setting };
}

function validateSettings(input) {
  if (!Array.isArray(input) || input.length > 16) {
    return rejected("task_settings_invalid", "settings must contain at most 16 entries");
  }
  const settings = [];
  for (let index = 0; index < input.length; index += 1) {
    const validation = validateSetting(input[index], index);
    if (validation.status !== "accepted") return validation;
    settings.push(validation.setting);
  }
  if (new Set(settings.map((setting) => setting.key)).size !== settings.length) {
    return rejected("task_setting_key_duplicate", "setting keys must be unique");
  }
  return { status: "accepted", settings };
}

function validateFields(input, mode) {
  let fields;
  try {
    fields = plainDataCopy(input);
  } catch (err) {
    return rejected("task_not_static_data", err && err.message ? err.message : String(err));
  }
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return rejected("task_record_invalid", "task fields must be an object");
  }
  const extra = unknownKey(fields, mode === "create" ? CREATE_KEYS : UPDATE_KEYS);
  if (extra) return rejected("task_field_unknown", `unknown task field: ${extra}`);
  if (!isValidLiveuiLibraryItemId(fields.taskId)) {
    return rejected(
      "task_id_invalid",
      "taskId must be 1-64 lowercase letters, digits, dot, underscore, or hyphen",
    );
  }
  if ((mode === "create" || hasOwn(fields, "name")) && (
    typeof fields.name !== "string" || !fields.name.trim() || fields.name.trim().length > 120
  )) {
    return rejected("task_name_invalid", "name must be 1-120 characters");
  }
  if (
    hasOwn(fields, "description") &&
    (typeof fields.description !== "string" || fields.description.length > 500)
  ) return rejected("task_description_invalid", "description must be at most 500 characters");
  if (
    hasOwn(fields, "icon") &&
    (typeof fields.icon !== "string" ||
      fields.icon.length > 32 ||
      (mode !== "owner" && fields.icon.length === 0) ||
      (fields.icon.length > 0 && !TASK_ICON_RE.test(fields.icon)))
  ) {
    return rejected(
      "task_icon_invalid",
      "icon must be 1-32 lowercase letters, digits, dot, underscore, or hyphen",
    );
  }
  if ((mode === "create" || hasOwn(fields, "request")) && (
    typeof fields.request !== "string" ||
    !fields.request.trim() ||
    fields.request.trim().length > 4000
  )) return rejected("task_request_invalid", "request must be 1-4000 characters");

  if (hasOwn(fields, "executor")) {
    const executor = validateExecutor(fields.executor);
    if (executor.status !== "accepted") return executor;
    fields.executor = executor.executor;
  }
  if (hasOwn(fields, "context") && !["isolated", "current_session"].includes(fields.context)) {
    return rejected("task_context_invalid", "context must be isolated or current_session");
  }
  if (hasOwn(fields, "settings")) {
    const settings = validateSettings(fields.settings);
    if (settings.status !== "accepted") return settings;
    fields.settings = settings.settings;
  }
  if (
    hasOwn(fields, "preferredTemplateId") &&
    fields.preferredTemplateId !== null &&
    !isValidLiveuiLibraryItemId(fields.preferredTemplateId)
  ) {
    return rejected("template_id_invalid", "preferredTemplateId must be a valid Template id or null");
  }
  if (hasOwn(fields, "name")) fields.name = fields.name.trim();
  if (hasOwn(fields, "request")) fields.request = fields.request.trim();
  return { status: "accepted", fields };
}

function recordWithinBound(digestInput) {
  const record = { ...digestInput, digest: liveuiLibraryDigest(digestInput) };
  return new TextEncoder().encode(canonicalSerialize(record)).byteLength <= TASK_MAX_BYTES;
}

function taskRecordPath(libraryRoot, taskId) {
  return path.join(libraryRoot, LIVEUI_TASK_LIBRARY_DIRNAME, `${taskId}.json`);
}

function normalizeAgentId(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "default";
}

function requireExpectedDigest(input) {
  if (!input || !hasOwn(input, "expectedDigest")) {
    return rejected("task_base_required", "expectedDigest is required for every Task edit");
  }
  if (typeof input.expectedDigest !== "string" || !input.expectedDigest) {
    return rejected("task_base_invalid", "expectedDigest must be a non-empty string");
  }
  return { status: "accepted", expectedDigest: input.expectedDigest };
}

function normalizeTaskMatchText(value) {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ")
    : "";
}

function taskMatchTokens(value) {
  const normalized = normalizeTaskMatchText(value);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter((token) => !TASK_MATCH_STOP_WORDS.has(token)));
}

function taskTokenScore(queryTokens, documentTokens) {
  let shared = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) shared += 1;
  }
  const union = new Set([...queryTokens, ...documentTokens]).size;
  return { shared, score: union > 0 ? shared / union : 0 };
}

function approvalSetting(setting) {
  const projected = { key: setting.key, type: setting.type };
  for (const key of ["label", "required", "maxLength", "min", "max", "options"]) {
    if (setting[key] !== undefined) {
      projected[key] = key === "options" ? setting.options.map((option) => option) : setting[key];
    }
  }
  return projected;
}

function taskVersionMetadata(record, version) {
  return {
    name: version && typeof version.name === "string"
      ? version.name
      : record.name,
    description: version && hasOwn(version, "description")
      ? version.description
      : typeof record.cosmetic.description === "string"
        ? record.cosmetic.description
        : "",
    preferredTemplateId: version && hasOwn(version, "preferredTemplateId")
      ? version.preferredTemplateId
      : typeof record.preferredTemplateId === "string"
        ? record.preferredTemplateId
        : null,
    preferredTemplateName: version && typeof version.preferredTemplateName === "string"
      ? version.preferredTemplateName
      : null,
  };
}

function approvalVersion(record, version, includeApprovedAtMs) {
  if (!version) return undefined;
  const metadata = taskVersionMetadata(record, version);
  const projected = {
    versionId: version.versionId,
    name: metadata.name,
    description: metadata.description,
    preferredTemplateId: metadata.preferredTemplateId,
    request: version.request,
    executor: {
      host: version.executor.host,
      agentId: version.executor.agentId,
    },
    context: version.context,
    settings: version.settings.map((setting) => approvalSetting(setting)),
  };
  if (includeApprovedAtMs && Number.isSafeInteger(version.approvedAtMs)) {
    projected.approvedAtMs = version.approvedAtMs;
  }
  return projected;
}

function projectedSettingValues(record) {
  const projected = {};
  const approved = record && record.versions && record.versions.approved;
  const source = record && record.settingValues;
  if (
    !approved ||
    !Array.isArray(approved.settings) ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source)
  ) return projected;
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(source);
  } catch (_) {
    return projected;
  }
  for (const contractEntry of approved.settings) {
    const descriptor = descriptors[contractEntry.key];
    if (!descriptor || !hasOwn(descriptor, "value")) continue;
    const validation = validateSettingValue(contractEntry, descriptor.value);
    if (validation.status === "accepted") projected[contractEntry.key] = validation.value;
  }
  return projected;
}

function prunedSettingValues(settingValues, approved) {
  if (settingValues === undefined) return undefined;
  const pruned = {};
  if (!approved || !Array.isArray(approved.settings)) return pruned;
  const contracts = new Map(approved.settings.map((entry) => [entry.key, entry]));
  for (const [key, value] of Object.entries(settingValues)) {
    const contractEntry = contracts.get(key);
    if (!contractEntry) continue;
    if (validateSettingValue(contractEntry, value).status === "accepted") pruned[key] = value;
  }
  return pruned;
}

function projectTaskForApproval(record, options = {}) {
  const reviewedVersion = record.versions.pending || record.versions.approved;
  const reviewedMetadata = taskVersionMetadata(record, reviewedVersion);
  const preferredTemplate = typeof options.resolveTemplateHint === "function" &&
    typeof reviewedMetadata.preferredTemplateId === "string"
    ? options.resolveTemplateHint(reviewedMetadata.preferredTemplateId)
    : null;
  const preferredTemplateName = reviewedMetadata.preferredTemplateName ||
    (preferredTemplate && preferredTemplate.name);
  const projected = {
    taskId: record.taskId,
    name: record.name,
    digest: record.digest,
    description: typeof record.cosmetic.description === "string"
      ? record.cosmetic.description
      : null,
    icon: typeof record.cosmetic.icon === "string" ? record.cosmetic.icon : null,
    settingValues: projectedSettingValues(record),
    hasPrevious: !!record.versions.previous,
    allToolsNotice: LIVEUI_TASK_ALL_TOOLS_NOTICE,
    toolApprovalBehaviour:
      typeof options.toolApprovalBehaviour === "string" && options.toolApprovalBehaviour.trim()
        ? options.toolApprovalBehaviour.trim()
        : LIVEUI_TASK_UNKNOWN_APPROVAL_BEHAVIOUR,
    preferredTemplate: preferredTemplate
      ? { templateId: preferredTemplate.templateId, name: preferredTemplateName }
      : null,
    exampleUi: preferredTemplate
      ? {
          label: "Example UI",
          templateId: preferredTemplate.templateId,
          name: preferredTemplateName,
          summary: typeof preferredTemplate.summary === "string"
            ? preferredTemplate.summary.slice(0, 200)
            : "",
        }
      : null,
  };
  const pending = approvalVersion(record, record.versions.pending, false);
  const approved = approvalVersion(record, record.versions.approved, true);
  if (pending) projected.pending = pending;
  if (approved) projected.approved = approved;
  return projected;
}

function createLiveuiTaskLibrary(opts = {}) {
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const host = opts.host;
  if (!["openclaw", "hermes"].includes(host)) {
    throw new Error("createLiveuiTaskLibrary requires host openclaw or hermes");
  }
  const library = createLiveuiLibrary({ libraryDir });
  const listItemsForDiscovery = typeof opts.listItemsForDiscovery === "function"
    ? opts.listItemsForDiscovery
    : () => library.listItems();
  const injectedNow = typeof opts.now === "function" ? opts.now : Date.now;

  const resolveTaskDefaults = typeof opts.taskDefaults === "function"
    ? () => {
      try {
        const value = opts.taskDefaults();
        return value && typeof value === "object" ? value : {};
      } catch (_) {
        return {};
      }
    }
    : () => ({});
  const findVisibleNameClash = typeof opts.findVisibleNameClash === "function"
    ? opts.findVisibleNameClash
    : () => null;
  const rejectNameClash = typeof opts.rejectNameClash === "function"
    ? opts.rejectNameClash
    : (clash) => rejected(
      "library_name_clash",
      `Visible name clashes with ${clash && clash.name ? clash.name : "another item"}`,
    );
  const removeOrganizationEntry = typeof opts.removeOrganizationEntry === "function"
    ? opts.removeOrganizationEntry
    : () => ({ status: "saved" });
  const deletionHooks = opts.deletionHooks && typeof opts.deletionHooks.onTaskDeleted === "function"
    ? opts.deletionHooks
    : { onTaskDeleted() { return { referencedTemplateIds: [] }; } };
  const resolveTemplateHint = typeof opts.resolveTemplateHint === "function"
    ? opts.resolveTemplateHint
    : () => null;
  const currentSurfaceSpecForSession = typeof opts.currentSurfaceSpecForSession === "function"
    ? opts.currentSurfaceSpecForSession
    : () => null;
  const saveHelperTemplate = typeof opts.saveHelperTemplate === "function"
    ? opts.saveHelperTemplate
    : () => rejected("save_ui_unavailable", "helper Template persistence is unavailable");
  const hideHelperTemplate = typeof opts.hideHelperTemplate === "function"
    ? opts.hideHelperTemplate
    : () => rejected("save_ui_unavailable", "helper Template organization is unavailable");
  const rollbackHelperTemplate = typeof opts.rollbackHelperTemplate === "function"
    ? opts.rollbackHelperTemplate
    : () => undefined;

  function resolvePreferredTemplate(templateId) {
    if (!isValidLiveuiLibraryItemId(templateId)) return null;
    try {
      const resolved = resolveTemplateHint(templateId);
      return resolved && resolved.templateId === templateId && typeof resolved.name === "string"
        ? resolved
        : null;
    } catch (_) {
      return null;
    }
  }

  function applyPreferredTemplate(record, templateId) {
    if (templateId !== null && !isValidLiveuiLibraryItemId(templateId)) {
      return rejected("template_id_invalid", "preferredTemplateId must be a valid Template id or null");
    }
    if (templateId !== null && !resolvePreferredTemplate(templateId)) {
      return rejected("template_not_found", `template not found: ${templateId}`);
    }
    const next = { ...record };
    delete next.digest;
    if (templateId === null) delete next.preferredTemplateId;
    else next.preferredTemplateId = templateId;
    return {
      status: "accepted",
      record: next,
      unchanged: (typeof record.preferredTemplateId === "string"
        ? record.preferredTemplateId
        : null) === templateId,
    };
  }

  function retainedPreferredTemplateId(record) {
    return typeof record.preferredTemplateId === "string" &&
      resolvePreferredTemplate(record.preferredTemplateId)
      ? record.preferredTemplateId
      : null;
  }

  function exists(taskId) {
    try {
      return fs.existsSync(taskRecordPath(libraryDir, taskId));
    } catch (_) {
      return false;
    }
  }

  function read(taskId) {
    if (!isValidLiveuiLibraryItemId(taskId)) {
      return rejected("task_id_invalid", "taskId is invalid");
    }
    if (!exists(taskId)) return rejected("task_not_found", `task not found: ${taskId}`);
    const loaded = library.loadItem("task", taskId);
    if (loaded.status !== "accepted") return loaded;
    return { status: "accepted", task: loaded.record };
  }

  function loadForOwnerWrite(taskId, options) {
    const base = requireExpectedDigest(options);
    if (base.status !== "accepted") return base;
    if (!isValidLiveuiLibraryItemId(taskId)) {
      return rejected("task_id_invalid", "taskId is invalid");
    }
    if (!exists(taskId)) return rejected("task_not_found", `task not found: ${taskId}`);
    const loaded = library.loadItem("task", taskId);
    if (loaded.status !== "accepted") return loaded;
    if (loaded.record.digest !== base.expectedDigest) {
      return {
        status: "rejected",
        code: "library_conflict",
        message: "saved item changed since it was read",
        currentDigest: loaded.record.digest,
      };
    }
    return { status: "accepted", expectedDigest: base.expectedDigest, record: loaded.record };
  }

  function saveOwnerWrite(
    taskId,
    current,
    versions,
    expectedDigest,
    settingValues = current.settingValues,
    metadata = null,
  ) {
    const effectiveMetadata = metadata || {
      name: current.name,
      description: typeof current.cosmetic.description === "string"
        ? current.cosmetic.description
        : "",
      preferredTemplateId: retainedPreferredTemplateId(current),
    };
    const baseInput = {
      schemaVersion: current.schemaVersion,
      itemType: current.itemType,
      taskId: current.taskId,
      name: effectiveMetadata.name,
      cosmetic: {
        ...current.cosmetic,
        description: effectiveMetadata.description,
      },
      versions,
      nextVersionNumber: current.nextVersionNumber,
    };
    if (settingValues !== undefined) baseInput.settingValues = settingValues;
    const preferred = applyPreferredTemplate(
      baseInput,
      effectiveMetadata.preferredTemplateId,
    );
    if (preferred.status !== "accepted") return preferred;
    const digestInput = preferred.record;
    if (!recordWithinBound(digestInput)) {
      return rejected("task_too_large", `task exceeds ${TASK_MAX_BYTES} canonical bytes`);
    }
    const saved = library.saveItem("task", taskId, digestInput, { expectedDigest });
    if (saved.status !== "saved") return saved;
    return { status: "saved", task: saved.record };
  }

  function findTasks(query) {
    const normalizedQuery = normalizeTaskMatchText(query);
    if (!normalizedQuery) {
      return rejected("task_query_invalid", "query must contain searchable text");
    }
    const queryTokens = taskMatchTokens(normalizedQuery);
    const matches = [];
    const listed = listItemsForDiscovery();
    for (const row of listed.items) {
      if (!row || row.itemType !== "task") continue;
      const loaded = library.loadItem("task", row.itemId);
      const record = loaded && loaded.status === "accepted" ? loaded.record : null;
      const approved = record && record.versions ? record.versions.approved : null;
      if (!approved) continue;
      const metadata = taskVersionMetadata(record, approved);
      const normalizedName = normalizeTaskMatchText(metadata.name);
      const exact = normalizedName && (
        normalizedQuery === normalizedName ||
        ` ${normalizedQuery} `.includes(` ${normalizedName} `)
      );
      let match = "exact_name";
      let score = 1;
      if (!exact) {
        const documentTokens = taskMatchTokens(
          `${metadata.name} ${metadata.description} ${approved.request}`,
        );
        const semantic = taskTokenScore(queryTokens, documentTokens);
        if (semantic.shared < 2 || semantic.score < TASK_SEMANTIC_THRESHOLD) continue;
        match = "semantic";
        score = semantic.score;
      }
      matches.push({
        taskId: record.taskId,
        name: metadata.name,
        description: metadata.description,
        request: approved.request,
        settings: approved.settings.map((setting) => approvalSetting(setting)),
        settingValues: projectedSettingValues(record),
        context: approved.context,
        preferredTemplate: (() => {
          const resolved = resolvePreferredTemplate(metadata.preferredTemplateId);
          return resolved && metadata.preferredTemplateName
            ? { templateId: resolved.templateId, name: metadata.preferredTemplateName }
            : null;
        })(),
        match,
        score,
      });
    }
    matches.sort((left, right) => {
      if (left.match !== right.match) return left.match === "exact_name" ? -1 : 1;
      if (left.score !== right.score) return right.score - left.score;
      return left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0;
    });
    const capped = matches.slice(0, TASK_MATCH_LIMIT);
    const ambiguous = capped.length > 1;
    return {
      status: "accepted",
      matches: capped,
      ambiguous,
      ...(ambiguous ? { hint: LIVEUI_TASK_AMBIGUITY_HINT } : {}),
    };
  }

  const controller = {
    libraryDir,
    createDraft(input, context = {}) {
      const validation = validateFields(input, "create");
      if (validation.status !== "accepted") return validation;
      const fields = validation.fields;
      if (exists(fields.taskId)) {
        return rejected("task_exists", `task already exists: ${fields.taskId}`);
      }
      const defaults = resolveTaskDefaults();
      const executor = fields.executor || {
        host,
        agentId: normalizeAgentId(
          defaults.defaultExecutor || (context && context.agentId),
        ),
      };
      const preferredTemplate = hasOwn(fields, "preferredTemplateId") &&
        fields.preferredTemplateId !== null
        ? resolvePreferredTemplate(fields.preferredTemplateId)
        : null;
      if (fields.preferredTemplateId && !preferredTemplate) {
        return rejected("template_not_found", `template not found: ${fields.preferredTemplateId}`);
      }
      const baseInput = {
        schemaVersion: LIVEUI_TASK_LIBRARY_SCHEMA_VERSION,
        itemType: "task",
        taskId: fields.taskId,
        name: fields.name,
        cosmetic: {
          ...(hasOwn(fields, "description") ? { description: fields.description } : {}),
          ...(hasOwn(fields, "icon") ? { icon: fields.icon } : {}),
        },
        versions: {
          pending: {
            versionId: "v1",
            name: fields.name,
            description: hasOwn(fields, "description") ? fields.description : "",
            preferredTemplateId: hasOwn(fields, "preferredTemplateId")
              ? fields.preferredTemplateId
              : null,
            preferredTemplateName: preferredTemplate ? preferredTemplate.name : null,
            request: fields.request,
            executor,
            context: fields.context || defaults.defaultContext || "isolated",
            settings: fields.settings || [],
            authoredBy: "agent",
          },
        },
        nextVersionNumber: 2,
      };
      const preferred = applyPreferredTemplate(
        baseInput,
        hasOwn(fields, "preferredTemplateId") ? fields.preferredTemplateId : null,
      );
      if (preferred.status !== "accepted") return preferred;
      const digestInput = preferred.record;
      if (!recordWithinBound(digestInput)) {
        return rejected("task_too_large", `task exceeds ${TASK_MAX_BYTES} canonical bytes`);
      }
      const saved = library.saveItem("task", fields.taskId, digestInput, { ifAbsent: true });
      if (saved.status === "rejected" && saved.code === "library_conflict") {
        return rejected("task_exists", `task already exists: ${fields.taskId}`);
      }
      if (saved.status !== "saved") return saved;
      return { status: "saved", task: saved.record };
    },
    updateDraft(input, context = {}) {
      if (!input || !hasOwn(input, "expectedDigest")) {
        return rejected("task_base_required", "expectedDigest is required for every Task edit");
      }
      const validation = validateFields(input, "owner");
      if (validation.status !== "accepted") return validation;
      const fields = validation.fields;
      if (typeof fields.expectedDigest !== "string" || !fields.expectedDigest) {
        return rejected("task_base_invalid", "expectedDigest must be a non-empty string");
      }
      if (
        hasOwn(fields, "replacePendingDraft") &&
        typeof fields.replacePendingDraft !== "boolean"
      ) {
        return rejected("task_replace_pending_invalid", "replacePendingDraft must be boolean");
      }
      if (!exists(fields.taskId)) {
        return rejected("task_not_found", `task not found: ${fields.taskId}`);
      }
      const loaded = library.loadItem("task", fields.taskId);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.record;
      if (current.digest !== fields.expectedDigest) {
        return {
          status: "rejected",
          code: "library_conflict",
          message: "saved item changed since it was read",
          currentDigest: current.digest,
        };
      }

      const base = context && context.baseApproved === true
        ? current.versions.approved
        : current.versions.pending || current.versions.approved;
      if (!base) return rejected("task_record_invalid", "Task has no editable version");
      const baseMetadata = taskVersionMetadata(current, base);
      const requestedPreferredTemplate = hasOwn(fields, "preferredTemplateId") &&
        fields.preferredTemplateId !== null
        ? resolvePreferredTemplate(fields.preferredTemplateId)
        : null;
      if (fields.preferredTemplateId && !requestedPreferredTemplate) {
        return rejected("template_not_found", `template not found: ${fields.preferredTemplateId}`);
      }
      const candidateApproval = {
        name: hasOwn(fields, "name") ? fields.name : baseMetadata.name,
        description: hasOwn(fields, "description")
          ? fields.description
          : baseMetadata.description,
        preferredTemplateId: hasOwn(fields, "preferredTemplateId")
          ? fields.preferredTemplateId
          : baseMetadata.preferredTemplateId,
        preferredTemplateName: hasOwn(fields, "preferredTemplateId")
          ? requestedPreferredTemplate
            ? requestedPreferredTemplate.name
            : null
          : baseMetadata.preferredTemplateName,
        request: hasOwn(fields, "request") ? fields.request : base.request,
        executor: hasOwn(fields, "executor") ? fields.executor : base.executor,
        context: hasOwn(fields, "context") ? fields.context : base.context,
        settings: hasOwn(fields, "settings") ? fields.settings : base.settings,
      };
      const baseApproval = {
        ...baseMetadata,
        request: base.request,
        executor: base.executor,
        context: base.context,
        settings: base.settings,
      };
      const authoritySupplied = AUTHORITY_KEYS.some((key) => hasOwn(fields, key));
      const metadataSupplied = APPROVAL_METADATA_KEYS.some((key) => hasOwn(fields, key));
      const authorityChanged = authoritySupplied && canonicalSerialize({
        request: candidateApproval.request,
        executor: candidateApproval.executor,
        context: candidateApproval.context,
        settings: candidateApproval.settings,
      }) !== canonicalSerialize({
        request: baseApproval.request,
        executor: baseApproval.executor,
        context: baseApproval.context,
        settings: baseApproval.settings,
      });
      const metadataChanged = metadataSupplied && canonicalSerialize({
        name: candidateApproval.name,
        description: candidateApproval.description,
        preferredTemplateId: candidateApproval.preferredTemplateId,
        preferredTemplateName: candidateApproval.preferredTemplateName,
      }) !== canonicalSerialize(baseMetadata);
      const approvalChanged =
        authorityChanged || metadataChanged;
      const cosmeticSupplied = COSMETIC_KEYS.some((key) => hasOwn(fields, key));
      if (!approvalChanged && !cosmeticSupplied) {
        return rejected("task_update_empty", "update_draft did not change the Task");
      }
      if (
        (authorityChanged || (metadataChanged && current.versions.approved)) &&
        current.versions.pending &&
        fields.replacePendingDraft !== true
      ) {
        return rejected(
          "task_draft_pending",
          "A pending Draft already exists. Ask the user before replacing it, then pass replacePendingDraft: true.",
        );
      }
      if (hasOwn(fields, "name")) {
        const clash = findVisibleNameClash(fields.taskId, fields.name);
        if (clash) return rejectNameClash(clash);
      }

      const baseInput = {
        schemaVersion: LIVEUI_TASK_LIBRARY_SCHEMA_VERSION,
        itemType: "task",
        taskId: current.taskId,
        name: hasOwn(fields, "name") ? fields.name : current.name,
        cosmetic: {
          ...current.cosmetic,
          ...(hasOwn(fields, "description") ? { description: fields.description } : {}),
          ...(hasOwn(fields, "icon") ? { icon: fields.icon } : {}),
        },
        versions: { ...current.versions },
        nextVersionNumber: current.nextVersionNumber,
      };
      if (current.settingValues !== undefined) {
        baseInput.settingValues = current.settingValues;
      }
      if (approvalChanged) {
        const metadataOnlyDraftEdit =
          metadataChanged && !authorityChanged && !current.versions.approved;
        baseInput.versions.pending = {
          versionId: metadataOnlyDraftEdit
            ? current.versions.pending.versionId
            : `v${current.nextVersionNumber}`,
          ...candidateApproval,
          authoredBy: metadataOnlyDraftEdit
            ? current.versions.pending.authoredBy
            : context && context.authoredBy === "phone" ? "phone" : "agent",
        };
        if (!metadataOnlyDraftEdit) {
          baseInput.nextVersionNumber = current.nextVersionNumber + 1;
        }
      }
      const requestedPreferredTemplateId = hasOwn(fields, "preferredTemplateId")
        ? candidateApproval.preferredTemplateId
        : retainedPreferredTemplateId(current);
      const preferred = applyPreferredTemplate(baseInput, requestedPreferredTemplateId);
      if (preferred.status !== "accepted") return preferred;
      if (!approvalChanged && !cosmeticSupplied && preferred.unchanged) {
        return { status: "unchanged", task: current };
      }
      const digestInput = preferred.record;
      if (!recordWithinBound(digestInput)) {
        return rejected("task_too_large", `task exceeds ${TASK_MAX_BYTES} canonical bytes`);
      }
      const saved = library.saveItem("task", fields.taskId, digestInput, {
        expectedDigest: fields.expectedDigest,
      });
      if (saved.status !== "saved") return saved;
      return { status: "saved", task: saved.record };
    },
    updateTaskContext(taskId, context) {
      const validation = validateFields({ taskId, context }, "update");
      if (validation.status !== "accepted") return validation;
      const loaded = read(taskId);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.task;
      const approved = current.versions && current.versions.approved;
      if (!approved) return rejected("task_not_ready", "Task has no approved version");
      if (approved.context === validation.fields.context) {
        return rejected("task_context_unchanged", "Task already uses that context");
      }
      return controller.updateDraft({
        taskId,
        context: validation.fields.context,
        expectedDigest: current.digest,
        replacePendingDraft: true,
      }, { authoredBy: "phone", baseApproved: true });
    },
    updateTaskExecutor(taskId, executorInput) {
      const executor = validateExecutor(executorInput);
      if (executor.status !== "accepted") return executor;
      const loaded = read(taskId);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.task;
      const base = current.versions.approved;
      if (!base) return rejected("task_not_ready", "Task has no approved version");
      if (canonicalSerialize(base.executor) === canonicalSerialize(executor.executor)) {
        return rejected("task_executor_unchanged", "Task already uses this Executor");
      }
      return controller.updateDraft({
        taskId,
        executor: executor.executor,
        expectedDigest: current.digest,
        replacePendingDraft: true,
      }, { authoredBy: "phone", baseApproved: true });
    },
    updateTaskSettingValues(taskId, valuesInput, options = {}) {
      let values;
      try {
        values = plainDataCopy(valuesInput);
      } catch (_) {
        const key = valuesInput && typeof valuesInput === "object" && !Array.isArray(valuesInput)
          ? Object.keys(valuesInput)[0] || ""
          : "";
        return {
          status: "rejected",
          code: "setting_value_invalid",
          invalid: [{ key, code: "setting_value_invalid" }],
        };
      }
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        return {
          status: "rejected",
          code: "setting_value_invalid",
          invalid: [{ key: "", code: "setting_value_invalid" }],
        };
      }
      const patchKeys = Object.keys(values);
      if (patchKeys.length > 16) {
        return {
          status: "rejected",
          code: "setting_value_invalid",
          invalid: patchKeys.map((key) => ({ key, code: "setting_value_invalid" })),
        };
      }
      const loaded = loadForOwnerWrite(taskId, options);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.record;
      const approved = current.versions.approved;
      if (!approved) {
        return rejected("task_not_approved", "Task Setting values require an approved version");
      }
      const contracts = new Map(approved.settings.map((entry) => [entry.key, entry]));
      const unknownSettingKey = patchKeys.find((key) => !contracts.has(key));
      if (unknownSettingKey) {
        const response = {
          status: "rejected",
          code: "setting_unknown",
          message: `unknown Task Setting: ${unknownSettingKey}`,
        };
        response.key = unknownSettingKey;
        return response;
      }
      const invalid = [];
      for (const key of patchKeys) {
        if (values[key] === null) continue;
        const validation = validateSettingValue(contracts.get(key), values[key]);
        if (validation.status !== "accepted") {
          invalid.push({ key, code: "setting_value_invalid" });
        }
      }
      if (invalid.length > 0) {
        return { status: "rejected", code: "setting_value_invalid", invalid };
      }
      const nextValues = { ...(current.settingValues || {}) };
      for (const key of patchKeys) {
        if (values[key] === null) delete nextValues[key];
        else nextValues[key] = values[key];
      }
      if (canonicalSerialize(nextValues) === canonicalSerialize(current.settingValues || {})) {
        return rejected("unchanged", "Task Setting values are unchanged");
      }
      return saveOwnerWrite(
        taskId,
        current,
        current.versions,
        loaded.expectedDigest,
        nextValues,
      );
    },
    approveTask(taskId, options = {}) {
      const loaded = loadForOwnerWrite(taskId, options);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.record;
      if (!current.versions.pending) {
        return rejected("task_no_pending", "Task has no pending Draft to approve");
      }
      const clash = findVisibleNameClash(taskId, current.name, { approving: true });
      if (clash) return rejectNameClash(clash);
      const nowValue = typeof options.now === "function"
        ? options.now()
        : Number.isSafeInteger(options.now)
          ? options.now
          : injectedNow();
      if (!Number.isSafeInteger(nowValue) || nowValue < 0) {
        return rejected("task_approved_at_invalid", "approval time must be a non-negative safe integer");
      }

      const pending = current.versions.pending;
      const defaults = resolveTaskDefaults();
      const inheritedContext = pending.context
        ? null
        : defaults.defaultContext || "isolated";
      const inheritedExecutor =
        pending.executor && pending.executor.agentId
          ? null
          : defaults.defaultExecutor
            ? { host, agentId: normalizeAgentId(defaults.defaultExecutor) }
            : null;
      const approved = {
        ...pending,
        ...(inheritedContext ? { context: inheritedContext } : {}),
        ...(inheritedExecutor ? { executor: inheritedExecutor } : {}),
        approvedAtMs: nowValue,
      };
      const versions = { approved };
      if (current.versions.approved) versions.previous = current.versions.approved;
      return saveOwnerWrite(
        taskId,
        current,
        versions,
        loaded.expectedDigest,
        prunedSettingValues(current.settingValues, approved),
        taskVersionMetadata(current, approved),
      );
    },
    rejectTask(taskId, options = {}) {
      const loaded = loadForOwnerWrite(taskId, options);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.record;
      if (!current.versions.pending) {
        return rejected("task_no_pending", "Task has no pending Draft to reject");
      }
      const versions = {};
      if (current.versions.approved) versions.approved = current.versions.approved;
      if (current.versions.previous) versions.previous = current.versions.previous;
      if (Object.keys(versions).length === 0) {
        const organization = removeOrganizationEntry("task", taskId);
        if (!organization || organization.status !== "saved") return organization;
        const deleted = library.deleteItem("task", taskId, {
          expectedDigest: loaded.expectedDigest,
        });
        if (deleted.status !== "deleted") return deleted;
        return { status: "saved", task: null };
      }
      return saveOwnerWrite(
        taskId,
        current,
        versions,
        loaded.expectedDigest,
        current.settingValues,
        current.versions.approved
          ? taskVersionMetadata(current, current.versions.approved)
          : null,
      );
    },
    undoTaskUpdate(taskId, options = {}) {
      const loaded = loadForOwnerWrite(taskId, options);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.record;
      if (!current.versions.previous) {
        return rejected("task_undo_unavailable", "Task has no previous approved version");
      }
      const versions = { approved: current.versions.previous };
      if (current.versions.pending) versions.pending = current.versions.pending;
      return saveOwnerWrite(
        taskId,
        current,
        versions,
        loaded.expectedDigest,
        prunedSettingValues(current.settingValues, current.versions.previous),
        taskVersionMetadata(current, current.versions.previous),
      );
    },
    updateTaskCosmetic(taskId, options = {}) {
      const input = { taskId };
      for (const key of OWNER_COSMETIC_KEYS) {
        if (hasOwn(options, key)) input[key] = options[key];
      }
      const validation = validateFields(input, "update");
      if (validation.status !== "accepted") return validation;
      if (!OWNER_COSMETIC_KEYS.some((key) => hasOwn(validation.fields, key))) {
        return rejected("task_update_empty", "cosmetic update did not change the Task");
      }
      const loaded = loadForOwnerWrite(taskId, options);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.record;
      if (hasOwn(validation.fields, "name")) {
        const clash = findVisibleNameClash(taskId, validation.fields.name);
        if (clash) return rejectNameClash(clash);
      }
      const versions = Object.fromEntries(
        Object.entries(current.versions).map(([slot, version]) => [
          slot,
          {
            ...version,
            ...(hasOwn(validation.fields, "name")
              ? { name: validation.fields.name }
              : {}),
            ...(hasOwn(validation.fields, "description")
              ? { description: validation.fields.description }
              : {}),
          },
        ]),
      );
      const baseInput = {
        schemaVersion: current.schemaVersion,
        itemType: current.itemType,
        taskId: current.taskId,
        name: hasOwn(validation.fields, "name") ? validation.fields.name : current.name,
        cosmetic: {
          ...current.cosmetic,
          ...(hasOwn(validation.fields, "description")
            ? { description: validation.fields.description }
            : {}),
          ...(hasOwn(validation.fields, "icon") && validation.fields.icon
            ? { icon: validation.fields.icon }
            : {}),
        },
        versions,
        nextVersionNumber: current.nextVersionNumber,
      };
      if (current.settingValues !== undefined) {
        baseInput.settingValues = current.settingValues;
      }
      if (hasOwn(validation.fields, "icon") && !validation.fields.icon) {
        delete baseInput.cosmetic.icon;
      }
      const preferred = applyPreferredTemplate(
        baseInput,
        retainedPreferredTemplateId(current),
      );
      if (preferred.status !== "accepted") return preferred;
      const digestInput = preferred.record;
      if (!recordWithinBound(digestInput)) {
        return rejected("task_too_large", `task exceeds ${TASK_MAX_BYTES} canonical bytes`);
      }
      const saved = library.saveItem("task", taskId, digestInput, {
        expectedDigest: loaded.expectedDigest,
      });
      if (saved.status !== "saved") return saved;
      return { status: "saved", task: saved.record };
    },
    setTaskPreferredTemplate(taskId, templateId, options = {}) {
      const loaded = loadForOwnerWrite(taskId, options);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.record;
      const resolvedTemplate = templateId === null ? null : resolvePreferredTemplate(templateId);
      if (templateId !== null && !resolvedTemplate) {
        return rejected("template_not_found", `template not found: ${templateId}`);
      }
      const versions = Object.fromEntries(
        Object.entries(current.versions).map(([slot, version]) => [
          slot,
          {
            ...version,
            preferredTemplateId: templateId,
            preferredTemplateName: resolvedTemplate ? resolvedTemplate.name : null,
          },
        ]),
      );
      const preferred = applyPreferredTemplate({ ...current, versions }, templateId);
      if (preferred.status !== "accepted") return preferred;
      const digestInput = preferred.record;
      const currentInput = { ...current };
      delete currentInput.digest;
      if (canonicalSerialize(digestInput) === canonicalSerialize(currentInput)) {
        return { status: "unchanged", task: current };
      }
      if (!recordWithinBound(digestInput)) {
        return rejected("task_too_large", `task exceeds ${TASK_MAX_BYTES} canonical bytes`);
      }
      const saved = library.saveItem("task", taskId, digestInput, {
        expectedDigest: loaded.expectedDigest,
      });
      if (saved.status !== "saved") return saved;
      return { status: "saved", task: saved.record };
    },
    saveUiAsHelper(input, context = {}) {
      const extra = unknownKey(input, SAVE_UI_KEYS);
      if (extra) return rejected("task_field_unknown", `unknown save_ui_as_helper field: ${extra}`);
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return rejected("task_input_invalid", "save_ui_as_helper input must be an object");
      }
      const loaded = read(input.taskId);
      if (loaded.status !== "accepted") return loaded;
      const current = loaded.task;
      if (input.expectedDigest !== undefined) {
        if (typeof input.expectedDigest !== "string" || !input.expectedDigest) {
          return rejected("task_base_invalid", "expectedDigest must be a non-empty string");
        }
        if (input.expectedDigest !== current.digest) {
          return {
            status: "rejected",
            code: "library_conflict",
            message: "saved item changed since it was read",
            currentDigest: current.digest,
          };
        }
      }
      const templateId = input.templateId === undefined
        ? `${current.taskId}-ui`
        : input.templateId;
      if (!isValidLiveuiLibraryItemId(templateId)) {
        return rejected("template_id_invalid", "templateId is invalid");
      }
      const name = input.name === undefined ? `${current.name} UI` : input.name;
      const spec = currentSurfaceSpecForSession(context.sessionKey);
      if (!spec) {
        return rejected("save_ui_no_current_surface", "no current LiveUI surface for this session");
      }
      let abstraction;
      try {
        abstraction = abstractSurfaceToTemplate(spec, { templateId, name });
      } catch (err) {
        return rejected(
          err && err.code === "save_ui_unsupported_kind"
            ? err.code
            : "save_ui_unsupported_kind",
          err && err.message ? err.message : "current surface cannot be saved as a Template",
        );
      }
      const templateSaved = saveHelperTemplate(abstraction.template, { taskId: current.taskId });
      if (templateSaved && templateSaved.status === "rejected" &&
          templateSaved.code === "library_conflict") {
        return rejected("template_exists", `template already exists: ${templateId}`);
      }
      if (!templateSaved || templateSaved.status !== "saved") return templateSaved;

      const rollback = () => {
        try {
          rollbackHelperTemplate(templateId, templateSaved.template.digest);
        } catch (_) {

        }
      };
      try {
        const hidden = hideHelperTemplate(templateId);
        if (!hidden || hidden.status !== "saved") {
          rollback();
          return hidden;
        }
        const taskSaved = controller.updateDraft({
          taskId: current.taskId,
          expectedDigest: current.digest,
          preferredTemplateId: templateId,
          replacePendingDraft: true,
        }, context);
        if (!taskSaved || taskSaved.status !== "saved") {
          rollback();
          return taskSaved;
        }
        return {
          status: "saved",
          templateId,
          hidden: true,
          preferredTemplateId: templateId,
          slots: abstraction.template.slots.map((slot) => slot.key),
          ...(abstraction.note === undefined ? {} : { note: abstraction.note }),
        };
      } catch (err) {
        rollback();
        throw err;
      }
    },
    deleteTask(taskId, options = {}) {
      const loaded = loadForOwnerWrite(taskId, options);
      const invalidRow = loaded.status === "accepted"
        ? null
        : library.listItems().items.find(
          (row) =>
            row &&
            row.status === "invalid" &&
            row.itemType === "task" &&
            row.itemId === taskId,
        );
      if (loaded.status !== "accepted" && !invalidRow) return loaded;
      const organization = removeOrganizationEntry("task", taskId);
      if (!organization || organization.status !== "saved") return organization;
      const deleted = library.deleteItem("task", taskId, {
        expectedDigest: loaded.status === "accepted"
          ? loaded.expectedDigest
          : options.expectedDigest,
      });
      if (deleted.status !== "deleted") return deleted;
      const cleanup = deletionHooks.onTaskDeleted(taskId, {
        preferredTemplateId: loaded.status === "accepted" &&
          typeof loaded.record.preferredTemplateId === "string"
          ? loaded.record.preferredTemplateId
          : null,
      }) || { referencedTemplateIds: [] };
      return {
        status: "deleted",
        taskId,
        referencedTemplateIds: Array.isArray(cleanup.referencedTemplateIds)
          ? cleanup.referencedTemplateIds
          : [],
      };
    },
    read,
    findTasks,
    list() {
      const listed = library.listItems();
      return {
        status: "accepted",
        tasks: listed.items.filter((row) => row.itemType === "task"),
      };
    },
    listItems(options = {}) {
      return library.listItems(options);
    },
  };
  return controller;
}

async function dispatchLiveuiTaskOperation(handler, args) {
  const operation = args && typeof args.operation === "string" ? args.operation : "";
  if (operation === "create_draft") {
    const { operation: _operation, ...input } = args;
    return handler.createTaskDraft(input);
  }
  if (operation === "update_draft") {
    const { operation: _operation, ...input } = args;
    return handler.updateTaskDraft(input);
  }
  if (operation === "read") return handler.readTask(args.taskId);
  if (operation === "list") return handler.listTasks();
  if (operation === "find_tasks") return handler.findTasks(args.query);
  if (operation === "save_ui_as_helper") {
    const { operation: _operation, ...input } = args;
    return handler.saveUiAsHelper(input);
  }
  return rejected(
    "task_operation_invalid",
    "operation must be create_draft, update_draft, read, list, find_tasks, or save_ui_as_helper",
  );
}

module.exports = { LIVEUI_TASK_LIBRARY_SCHEMA_VERSION, LIVEUI_TASK_LIBRARY_DIRNAME, LIVEUI_TASK_TOOL_NAME, LIVEUI_TASK_TOOL_DESCRIPTION, LIVEUI_TASK_ALL_TOOLS_NOTICE, LIVEUI_TASK_UNKNOWN_APPROVAL_BEHAVIOUR, liveuiTaskToolParametersSchema, validateSettingValue, projectTaskForApproval, createLiveuiTaskLibrary, dispatchLiveuiTaskOperation };
