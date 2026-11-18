const { createHash, randomUUID } = require("node:crypto");

const nodeFs = require("node:fs");

const { homedir } = require("node:os");

const path = require("node:path");
const { withProgramCardModelDeleteLease, markProgramCardModelDeleted } = require("./glasses-ui-program-card-model-lease.cjs");
const { LIVEUI_TEMPLATE_V1_SAVED_SHAPE, LIVEUI_TEMPLATE_V2_DIRNAME, LIVEUI_TEMPLATE_V2_SAVED_SHAPE, LIVEUI_TEMPLATE_V2_SCHEMA_VERSION, liveuiTemplateRowDescription, validateLiveuiTemplateV2Record } = require("./glasses-ui-template-v2.cjs");
const { OCUCLAW_CARD_IDS, isOcuclawCardId, ocuclawCardDigestInput } = require("./glasses-ui-ocuclaw-cards.cjs");
const { normalizeTaskSlots } = require("./glasses-ui-task-slots.cjs");
const { carryUnknownFields, hasUnknownFields, knownFields } = require("./saved-format.cjs");

const LIVEUI_LIBRARY_ITEM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CARD_DELETE_LISTENERS = Symbol.for("ocuclaw.program-card.delete-listeners");
const cardDeleteListeners           = (globalThis       )[CARD_DELETE_LISTENERS] ||= new Set();

function onProgramCardDeleted(libraryDir     , callback                         ) {
  const entry = { root: resolveLiveuiLibraryRoot(libraryDir), callback };
  cardDeleteListeners.add(entry);
  return () => cardDeleteListeners.delete(entry);
}

const TASK_RECORD_KEYS = new Set([
  "schemaVersion",
  "itemType",
  "taskId",
  "name",
  "cosmetic",
  "settingValues",
  "preferredTemplateId",
  "versions",
  "nextVersionNumber",
  "digest",
]);
const TASK_COSMETIC_KEYS = new Set(["description", "icon"]);
const TASK_VERSION_KEYS = new Set([
  "versionId",
  "name",
  "description",
  "preferredTemplateId",
  "preferredTemplateName",
  "request",
  "executor",
  "context",
  "settings",
  "authoredBy",
  "approvedAtMs",
]);
const TASK_EXECUTOR_KEYS = new Set(["host", "agentId"]);
const TASK_SETTING_KEYS = new Set([
  "key",
  "type",
  "label",
  "required",
  "maxLength",
  "min",
  "max",
  "options",
]);
const TASK_VERSION_SLOT_KEYS = new Set(["approved", "pending", "previous"]);

const TASK_SAVED_SHAPE             = Object.freeze({
  fields: [...TASK_RECORD_KEYS],
  parts: { cosmetic: { fields: [...TASK_COSMETIC_KEYS] } },
  maps: {
    versions: {
      keys: [...TASK_VERSION_SLOT_KEYS],
      by: "versionId",
      fields: [...TASK_VERSION_KEYS],
      parts: { executor: { fields: [...TASK_EXECUTOR_KEYS] } },
      lists: { settings: { by: "key", fields: [...TASK_SETTING_KEYS] } },
    },
  },
});
const TASK_ICON_RE = /^[a-z0-9._-]+$/;
const TASK_VERSION_ID_RE = /^v([1-9][0-9]*)$/;
const TASK_MAX_BYTES = 64 * 1024;

const PROGRAM_CARD_REVISIONS_DIRECTORY = "app-revisions-v1";

const PROGRAM_CARD_REVIEWS_DIRECTORY = "app-reviews-v1";
const LIVEUI_LIBRARY_METADATA_DIRS = new Set([
  "executors-v1",
  "task-runs-v1",
  "template-values-v1",
  "program-card-bindings-v1",
  "program-card-link-proposals-v1",
  "task-presentation-card-owners-v1",
  "task-open-update-v1",

  "task-uses-v1",

  "task-fit-v1",

  "task-runs-week-v1",
  PROGRAM_CARD_REVISIONS_DIRECTORY,
  PROGRAM_CARD_REVIEWS_DIRECTORY,
  "program-card-vision-v1",
  "program-card-model-threads-v1",

  "program-card-starters-v1",
  "task-kept-looks-v1",
]);

function hasOnlyKeys(value     , allowed     ) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validTaskSetting(setting     ) {
  if (!setting || typeof setting !== "object" || Array.isArray(setting)) return false;
  if (!hasOnlyKeys(setting, TASK_SETTING_KEYS)) return false;
  if (!isValidLiveuiLibraryItemId(setting.key)) return false;
  if (!["string", "number", "boolean", "enum"].includes(setting.type)) return false;
  if (
    setting.label !== undefined &&
    (typeof setting.label !== "string" || setting.label.length > 80)
  ) return false;
  if (setting.required !== undefined && typeof setting.required !== "boolean") return false;
  if (setting.type === "string") {
    if (
      setting.maxLength !== undefined &&
      (!Number.isSafeInteger(setting.maxLength) ||
        setting.maxLength < 1 ||
        setting.maxLength > 4000)
    ) return false;
  } else if (setting.maxLength !== undefined) {
    return false;
  }
  if (setting.type === "number") {
    if (setting.min !== undefined && !Number.isFinite(setting.min)) return false;
    if (setting.max !== undefined && !Number.isFinite(setting.max)) return false;
    if (
      setting.min !== undefined &&
      setting.max !== undefined &&
      setting.min > setting.max
    ) return false;
  } else if (setting.min !== undefined || setting.max !== undefined) {
    return false;
  }
  if (setting.type === "enum") {
    if (!Array.isArray(setting.options) || setting.options.length < 1 || setting.options.length > 16) {
      return false;
    }
    if (
      setting.options.some(
        (option     ) =>
          typeof option !== "string" || option.length > 64,
      )
    ) return false;
  } else if (setting.options !== undefined) {
    return false;
  }
  return true;
}

function validateSettingValue(contractEntry     , value     ) {
  const key = contractEntry && typeof contractEntry.key === "string"
    ? contractEntry.key
    : "";
  const invalid = { status: "rejected", code: "setting_value_invalid", key };
  if (!contractEntry || typeof contractEntry !== "object" || Array.isArray(contractEntry)) {
    return invalid;
  }
  if (contractEntry.type === "string") {
    const maxLength = Number.isSafeInteger(contractEntry.maxLength)
      ? contractEntry.maxLength
      : 4000;
    if (
      typeof value !== "string" ||
      value.trim().length > maxLength ||
      /[\u0000-\u0009\u000b-\u001f\u007f]/.test(value)
    ) return invalid;
  } else if (contractEntry.type === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (contractEntry.min !== undefined && value < contractEntry.min) ||
      (contractEntry.max !== undefined && value > contractEntry.max)
    ) return invalid;
  } else if (contractEntry.type === "boolean") {
    if (typeof value !== "boolean") return invalid;
  } else if (contractEntry.type === "enum") {
    if (
      typeof value !== "string" ||
      !Array.isArray(contractEntry.options) ||
      !contractEntry.options.includes(value)
    ) return invalid;
  } else {
    return invalid;
  }
  return { status: "accepted", key, value };
}

function validTaskVersion(version     ) {
  if (!version || typeof version !== "object" || Array.isArray(version)) return false;
  if (!hasOnlyKeys(version, TASK_VERSION_KEYS)) return false;
  if (typeof version.versionId !== "string" || !TASK_VERSION_ID_RE.test(version.versionId)) {
    return false;
  }
  if (
    version.name !== undefined &&
    (typeof version.name !== "string" ||
      !version.name.trim() ||
      version.name !== version.name.trim() ||
      version.name.length > 120)
  ) return false;
  if (
    version.description !== undefined &&
    (typeof version.description !== "string" || version.description.length > 500)
  ) return false;
  if (
    version.preferredTemplateId !== undefined &&
    version.preferredTemplateId !== null &&
    !isValidLiveuiLibraryItemId(version.preferredTemplateId)
  ) return false;
  if (
    version.preferredTemplateName !== undefined &&
    version.preferredTemplateName !== null &&
    (typeof version.preferredTemplateName !== "string" ||
      !version.preferredTemplateName.trim() ||
      version.preferredTemplateName !== version.preferredTemplateName.trim() ||
      version.preferredTemplateName.length > 120)
  ) return false;
  if (
    typeof version.request !== "string" ||
    !version.request.trim() ||
    version.request !== version.request.trim() ||
    version.request.length > 4000
  ) return false;
  if (
    !version.executor ||
    typeof version.executor !== "object" ||
    Array.isArray(version.executor) ||
    !hasOnlyKeys(version.executor, TASK_EXECUTOR_KEYS) ||
    !["openclaw", "hermes"].includes(version.executor.host) ||
    typeof version.executor.agentId !== "string" ||
    !version.executor.agentId.trim() ||
    version.executor.agentId !== version.executor.agentId.trim()
  ) return false;
  if (!["isolated", "current_session"].includes(version.context)) return false;
  if (!Array.isArray(version.settings) || version.settings.length > 16) return false;
  if (!version.settings.every(validTaskSetting)) return false;
  if (new Set(version.settings.map((setting     ) => setting.key)).size !== version.settings.length) {
    return false;
  }
  if (
    version.approvedAtMs !== undefined &&
    (!Number.isSafeInteger(version.approvedAtMs) || version.approvedAtMs < 0)
  ) return false;
  return ["agent", "phone"].includes(version.authoredBy);
}

function validTaskRecord(record     ) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (!hasOnlyKeys(record, TASK_RECORD_KEYS)) return false;
  if (record.schemaVersion !== 1 || record.itemType !== "task") return false;
  if (!isValidLiveuiLibraryItemId(record.taskId)) return false;
  if (
    typeof record.name !== "string" ||
    !record.name.trim() ||
    record.name !== record.name.trim() ||
    record.name.length > 120
  ) return false;
  if (
    !record.cosmetic ||
    typeof record.cosmetic !== "object" ||
    Array.isArray(record.cosmetic) ||
    !hasOnlyKeys(record.cosmetic, TASK_COSMETIC_KEYS)
  ) return false;
  if (
    record.preferredTemplateId !== undefined &&
    !isValidLiveuiLibraryItemId(record.preferredTemplateId)
  ) return false;
  if (
    record.cosmetic.description !== undefined &&
    (typeof record.cosmetic.description !== "string" || record.cosmetic.description.length > 500)
  ) return false;
  if (
    record.cosmetic.icon !== undefined &&
    (typeof record.cosmetic.icon !== "string" ||
      record.cosmetic.icon.length > 32 ||
      !TASK_ICON_RE.test(record.cosmetic.icon))
  ) return false;
  if (
    !record.versions ||
    typeof record.versions !== "object" ||
    Array.isArray(record.versions) ||
    !hasOnlyKeys(record.versions, TASK_VERSION_SLOT_KEYS)
  ) return false;
  const versions = Object.values(record.versions);
  if (versions.length < 1 || !versions.every(validTaskVersion)) return false;
  const versionNumbers = versions.map((version     ) => Number(version.versionId.slice(1)));
  if (new Set(versionNumbers).size !== versionNumbers.length) return false;
  if (
    !Number.isSafeInteger(record.nextVersionNumber) ||
    record.nextVersionNumber < 1 ||
    record.nextVersionNumber <= Math.max(...versionNumbers)
  ) return false;
  if (record.settingValues !== undefined) {
    if (
      !record.settingValues ||
      typeof record.settingValues !== "object" ||
      Array.isArray(record.settingValues)
    ) return false;
    const valueKeys = Object.keys(record.settingValues);
    if (valueKeys.length > 16) return false;
    const approved = record.versions.approved;
    const contractByKey = new Map(
      approved ? approved.settings.map((setting     ) => [setting.key, setting]) : [],
    );
    for (const key of valueKeys) {
      const contractEntry = contractByKey.get(key);
      if (!contractEntry) return false;
      if (validateSettingValue(contractEntry, record.settingValues[key]).status !== "accepted") {
        return false;
      }
    }
  }
  if (typeof record.digest !== "string" || !record.digest) return false;
  return savedBytes(record) <= TASK_MAX_BYTES;
}

function savedBytes(record     ) {
  return new TextEncoder().encode(canonicalSerialize(record)).byteLength;
}

function projectTaskRow(record     , executorStateProvider      = null) {
  const approved = record.versions.approved;
  const projectedState = approved && typeof executorStateProvider === "function"
    ? executorStateProvider(approved.executor, approved)
    : null;
  const status = approved
    ? projectedState && ["ready", "needs_setup", "unavailable"].includes(projectedState.state)
      ? projectedState.state
      : "ready"
    : "draft";
  return {
    itemType: "task",
    itemId: record.taskId,
    name: approved && typeof approved.name === "string"
      ? approved.name
      : record.name,
    digest: record.digest,
    ...(approved ? { description: libraryDescription(record.cosmetic?.description || approved.description || approved.request) } : {}),
    status,
    ...(approved && ["needs_setup", "unavailable"].includes(status) &&
      projectedState && typeof projectedState.reason === "string"
      ? { reason: projectedState.reason }
      : {}),
    approvedVersionId: approved ? approved.versionId : null,
    approvedAtMs: approved && Number.isSafeInteger(approved.approvedAtMs)
      ? approved.approvedAtMs
      : null,
    pendingDraft: !!record.versions.pending,
  };
}

const APP_RECORD_KEYS = new Set([
  "schemaVersion",
  "itemType",
  "appId",
  "name",
  "card",
  "checkpoint",
  "createdAtMs",
  "revision",
  "recoverySave",
  "cosmetic",
  "asks",
  "taskSlots",
  "digest",
]);
const APP_CHECKPOINT_KEYS = new Set(["seq", "state", "savedAtMs"]);
const APP_COSMETIC_KEYS = new Set(["description", "icon", "iconBy", "iconFor"]);

const APP_SAVED_SHAPE             = Object.freeze({
  fields: [...APP_RECORD_KEYS],
  parts: {
    card: { fields: ["kind", "id", "source"], replaced: true },
    checkpoint: { fields: [...APP_CHECKPOINT_KEYS], replaced: true },
    recoverySave: { fields: ["draftId", "revision"], replaced: true },
    cosmetic: { fields: [...APP_COSMETIC_KEYS] },
    asks: { fields: ["request", "requirements"], replaced: true },
  },
  lists: { taskSlots: { by: "name", fields: ["name", "label", "inputs", "maxBytes"] } },
});
const PROGRAM_CARD_ICON_BY = Object.freeze(["jev", "keywords", "wearer"]);
const PROGRAM_CARD_ICON_RE = /^[a-z0-9-]{1,32}$/;
const PROGRAM_CARD_ICON_FOR_RE = /^[0-9a-f]{8}$/;
const PROGRAM_CARD_REVISION_NUMBER_MAX = 999999;
const PROGRAM_CARD_NAME_MAX = 60;
const PROGRAM_CARD_DESCRIPTION_MAX = 120;
const PROGRAM_CARD_SOURCE_MAX = 131072;
const PROGRAM_CARD_STATE_MAX_BYTES = 32768;
const PROGRAM_CARD_SHOWCASE_ID_RE = /^[a-z0-9-]{1,32}$/;

function normalizeProgramCardAsks(value     )      {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some(key => key !== "request" && key !== "requirements")) return null;
  if (value.request !== undefined && (typeof value.request !== "string" || !value.request.trim() || value.request.length > 500)) return null;
  if (value.requirements !== undefined && (!Array.isArray(value.requirements) || value.requirements.length > 6 ||
    value.requirements.some((item     ) => typeof item !== "string" || !item.trim() || item.length > 80))) return null;
  if (value.request === undefined && !value.requirements?.length) return null;
  return {
    ...(value.request !== undefined ? { request: value.request.trim() } : {}),
    ...(value.requirements !== undefined ? { requirements: value.requirements.map((item        ) => item.trim()) } : {}),
  };
}

function validProgramCardName(name     ) {
  return typeof name === "string" &&
    name.trim().length >= 1 &&
    name === name.trim() &&
    name.length <= PROGRAM_CARD_NAME_MAX;
}

function normalizeProgramCardDescription(text     ) {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > PROGRAM_CARD_DESCRIPTION_MAX
    ? line.slice(0, PROGRAM_CARD_DESCRIPTION_MAX).trimEnd()
    : line;
}

function validAppCosmetic(cosmetic     ) {
  if (cosmetic === undefined) return true;
  if (!cosmetic || typeof cosmetic !== "object" || Array.isArray(cosmetic)) return false;
  if (!hasOnlyKeys(cosmetic, APP_COSMETIC_KEYS)) return false;
  if (cosmetic.description !== undefined && normalizeProgramCardDescription(cosmetic.description) !== cosmetic.description) {
    return false;
  }
  if (cosmetic.icon !== undefined && (typeof cosmetic.icon !== "string" || !PROGRAM_CARD_ICON_RE.test(cosmetic.icon))) {
    return false;
  }
  if (cosmetic.iconBy !== undefined && !PROGRAM_CARD_ICON_BY.includes(cosmetic.iconBy)) return false;
  return cosmetic.iconFor === undefined ||
    (typeof cosmetic.iconFor === "string" && PROGRAM_CARD_ICON_FOR_RE.test(cosmetic.iconFor));
}

function validProgramCardSpec(card     ) {
  if (!card || typeof card !== "object" || Array.isArray(card)) return false;
  if (card.kind === "showcase") {
    return hasOnlyKeys(card, new Set(["kind", "id"])) &&
      typeof card.id === "string" &&
      PROGRAM_CARD_SHOWCASE_ID_RE.test(card.id);
  }
  if (card.kind === "source") {
    return hasOnlyKeys(card, new Set(["kind", "source"])) &&
      typeof card.source === "string" &&
      card.source.length <= PROGRAM_CARD_SOURCE_MAX;
  }
  return false;
}

function programCardStateBytes(state     ) {
  if (state === undefined) return -1;
  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (_) {
    return -1;
  }
  if (typeof serialized !== "string") return -1;
  return new TextEncoder().encode(serialized).byteLength;
}

const PROGRAM_CARD_STATE_MAX_DEPTH = 512;

function programCardStateDepthOk(state     ) {
  if (!isCanonicalContainer(state)) return true;
  const stack                       = [[state, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() ;
    if (depth > PROGRAM_CARD_STATE_MAX_DEPTH) return false;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) if (isCanonicalContainer(child)) stack.push([child, depth + 1]);
  }
  return true;
}

function validAppRecord(record     ) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (!hasOnlyKeys(record, APP_RECORD_KEYS)) return false;
  if (record.schemaVersion !== 1 || record.itemType !== "app") return false;
  if (!isValidLiveuiLibraryItemId(record.appId)) return false;
  if (!validProgramCardName(record.name)) return false;
  if (!validProgramCardSpec(record.card)) return false;
  const checkpoint = record.checkpoint;
  if (
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint) ||
    !hasOnlyKeys(checkpoint, APP_CHECKPOINT_KEYS)
  ) return false;
  if (!Number.isSafeInteger(checkpoint.seq) || checkpoint.seq < 0) return false;
  if (!Number.isSafeInteger(checkpoint.savedAtMs)) return false;
  const stateBytes = programCardStateBytes(checkpoint.state);
  if (stateBytes < 0 || stateBytes > PROGRAM_CARD_STATE_MAX_BYTES) return false;
  if (!Number.isSafeInteger(record.createdAtMs)) return false;
  if (record.revision !== undefined && !validProgramCardRevisionNumber(record.revision)) return false;
  if (record.recoverySave !== undefined && (!record.recoverySave ||
    !hasOnlyKeys(record.recoverySave, new Set(["draftId", "revision"])) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.recoverySave.draftId) ||
    !validProgramCardRevisionNumber(record.recoverySave.revision))) return false;
  if (!validAppCosmetic(record.cosmetic)) return false;
  if (record.asks !== undefined && !normalizeProgramCardAsks(record.asks)) return false;

  if (record.taskSlots !== undefined && !normalizeTaskSlots(record.taskSlots)) return false;
  return typeof record.digest === "string" && !!record.digest;
}

function validProgramCardRevisionNumber(value     ) {
  return Number.isSafeInteger(value) && value >= 1 && value <= PROGRAM_CARD_REVISION_NUMBER_MAX;
}

function programCardCurrentRevision(record     ) {
  return record && validProgramCardRevisionNumber(record.revision) ? record.revision : 1;
}

function projectAppRow(record     ) {
  const cosmetic = record.cosmetic || {};
  return {
    itemType: "app",
    itemId: record.appId,
    name: record.name,
    description: cosmetic.description || "Saved card",
    ...(cosmetic.icon ? { icon: cosmetic.icon } : {}),
    digest: record.digest,
    status: "ready",
    savedAtMs: record.checkpoint.savedAtMs,
    revision: programCardCurrentRevision(record),
  };
}

const LIVEUI_LIBRARY_ITEM_TYPES = Object.freeze({
  template: Object.freeze({
    itemType: "template",
    directory: "templates-v1",
    schemaVersion: 1,
    idField: "templateId",
    supported: true,

    shape: LIVEUI_TEMPLATE_V1_SAVED_SHAPE,
  }),
  task: Object.freeze({
    itemType: "task",
    directory: "tasks-v1",
    schemaVersion: 1,
    idField: "taskId",
    supported: true,
    validateRecord: validTaskRecord,
    shape: TASK_SAVED_SHAPE,
    maxBytes: TASK_MAX_BYTES,
    projectRow: projectTaskRow,
  }),
  app: Object.freeze({
    itemType: "app",
    directory: "apps-v1",
    schemaVersion: 1,
    idField: "appId",
    supported: true,
    validateRecord: validAppRecord,
    shape: APP_SAVED_SHAPE,
    projectRow: projectAppRow,
  }),
});

function resolveLiveuiTemplateV2Dir(v1Directory     ) {
  const v1 = path.resolve(v1Directory);
  return path.basename(v1) === LIVEUI_LIBRARY_ITEM_TYPES.template.directory
    ? path.join(path.dirname(v1), LIVEUI_TEMPLATE_V2_DIRNAME)
    : path.join(v1, LIVEUI_TEMPLATE_V2_DIRNAME);
}

function isValidLiveuiLibraryItemId(itemId     ) {
  return typeof itemId === "string" && LIVEUI_LIBRARY_ITEM_ID_RE.test(itemId);
}

const isCanonicalContainer = (value     ) => Array.isArray(value) || (!!value && typeof value === "object");

function canonicalize(root     )      {
  if (!isCanonicalContainer(root)) return root;
  const shell = (value     ) => (Array.isArray(value) ? new Array(value.length) : Object.create(null));
  const frame = (source     , output     ) => {
    const keys = Array.isArray(source) ? null : Object.keys(source).sort();
    return { source, output, keys, length: keys ? keys.length : source.length, index: 0 };
  };
  const output = shell(root);
  const stack = [frame(root, output)];

  const open = new Set([root]);
  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    if (top.index >= top.length) {
      stack.pop();
      open.delete(top.source);
      continue;
    }
    const index = top.index++;
    let key     ;
    if (top.keys) {
      key = top.keys[index];
    } else {
      if (!(index in top.source)) continue;
      key = index;
    }
    const child = top.source[key];
    if (!isCanonicalContainer(child)) {
      top.output[key] = child;
      continue;
    }
    if (open.has(child)) throw new TypeError("Converting circular structure to JSON");
    const copy = shell(child);
    top.output[key] = copy;
    open.add(child);
    stack.push(frame(child, copy));
  }
  return output;
}

function canonicalSerialize(value     ) {
  return JSON.stringify(canonicalize(value));
}

function liveuiLibraryDigest(value     ) {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function liveuiLibraryItemKey(itemType     , itemId     ) {
  return `${itemType}:${itemId}`;
}

const DEFAULT_LIBRARY_TYPE_RANK      = { template: 0, task: 1, app: 2 };

function defaultLibraryItemRank(item     ) {
  return typeof item.itemType === "string" &&
    Object.prototype.hasOwnProperty.call(DEFAULT_LIBRARY_TYPE_RANK, item.itemType)
    ? DEFAULT_LIBRARY_TYPE_RANK[item.itemType]
    : 3;
}

function defaultLibraryItemOrder(left     , right     ) {
  const leftRank = defaultLibraryItemRank(left);
  const rightRank = defaultLibraryItemRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;

  if (left.itemType === "app" && right.itemType === "app") {
    const leftSavedAt = Number.isSafeInteger(left.savedAtMs) ? left.savedAtMs : 0;
    const rightSavedAt = Number.isSafeInteger(right.savedAtMs) ? right.savedAtMs : 0;
    if (leftSavedAt !== rightSavedAt) return rightSavedAt - leftSavedAt;
  }
  if (left.itemType === "task" && right.itemType === "task") {
    const leftApprovedAt = Number.isSafeInteger(left.approvedAtMs)
      ? left.approvedAtMs
      : Number.MAX_SAFE_INTEGER;
    const rightApprovedAt = Number.isSafeInteger(right.approvedAtMs)
      ? right.approvedAtMs
      : Number.MAX_SAFE_INTEGER;
    if (leftApprovedAt !== rightApprovedAt) return leftApprovedAt - rightApprovedAt;
  }
  const leftId = typeof left.itemId === "string" ? left.itemId : "";
  const rightId = typeof right.itemId === "string" ? right.itemId : "";
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function orderLiveuiLibraryItems(items     , organization      = null) {
  if (!Array.isArray(items)) return [];
  const byKey = new Map();
  for (const item of items) {
    if (!item || typeof item.itemType !== "string" || typeof item.itemId !== "string") continue;
    byKey.set(liveuiLibraryItemKey(item.itemType, item.itemId), item);
  }
  const ordered      = [];
  const seen = new Set();
  const requestedOrder = organization && Array.isArray(organization.order)
    ? organization.order
    : [];
  for (const key of requestedOrder) {
    const item = byKey.get(key);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    ordered.push(item);
  }
  const tail = Array.from(byKey.entries())
    .filter(([key]) => !seen.has(key))
    .map(([, item]) => item)
    .sort(defaultLibraryItemOrder);
  return [...ordered, ...tail];
}

function libraryDescription(value     ) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 500) : "";
}

function projectLiveuiLibraryForGlasses(items     , organization      = null) {
  if (!Array.isArray(items)) return [];
  const hidden = new Set(
    organization && Array.isArray(organization.hidden) ? organization.hidden : [],
  );
  return orderLiveuiLibraryItems(items, organization)
    .filter((item     ) =>
      item &&
      (
        item.status === "ready" ||
        (item.itemType === "task" && ["needs_setup", "unavailable"].includes(item.status))
      ) &&
      !hidden.has(liveuiLibraryItemKey(item.itemType, item.itemId)),
    )
    .map((item     ) => ({
      itemType: item.itemType,
      itemId: item.itemId,
      name: item.name,
      status: item.status,
      ...(libraryDescription(item.description) ? { description: libraryDescription(item.description) } : {}),
      ...(["needs_setup", "unavailable"].includes(item.status) &&
        typeof item.reason === "string"
        ? { reason: item.reason }
        : {}),

      ...(item.itemType === "app" && Number.isSafeInteger(item.savedAtMs) ? { savedAtMs: item.savedAtMs } : {}),

      ...(item.itemType === "app" && validProgramCardRevisionNumber(item.revision) ? { revision: item.revision } : {}),

      ...(item.itemType === "app" && typeof item.icon === "string" && PROGRAM_CARD_ICON_RE.test(item.icon)
        ? { icon: item.icon }
        : {}),
    }));
}

function invalidProjection(itemType     , itemId     , reason     , record      = null) {
  const projection      = {
    itemType: typeof itemType === "string" ? itemType : "",
    itemId: typeof itemId === "string" ? itemId : "",
    status: "invalid",
    reason,
  };
  if (record && typeof record.name === "string") projection.name = record.name;
  if (record && typeof record.digest === "string") projection.digest = record.digest;
  return projection;
}

function registryEntry(itemType     )      {
  if (
    typeof itemType !== "string" ||
    !Object.prototype.hasOwnProperty.call(LIVEUI_LIBRARY_ITEM_TYPES, itemType)
  ) {
    return null;
  }
  return Reflect.get(LIVEUI_LIBRARY_ITEM_TYPES, itemType);
}

function lookupLiveuiLibraryItemType(itemType     ) {
  const entry = registryEntry(itemType);
  if (!entry) return invalidProjection(itemType, "", "item_type_unknown");
  if (!entry.supported) return invalidProjection(itemType, "", "item_type_unsupported");
  return {
    status: "accepted",
    itemType: entry.itemType,
    directory: entry.directory,
  };
}

function resolveLiveuiLibraryRoot(libraryDir     ) {
  if (typeof libraryDir === "string" && libraryDir.trim()) {
    return path.resolve(libraryDir.trim());
  }
  return path.join(homedir(), ".ocuclaw", "liveui-library");
}

function resolveLiveuiLibraryTypeDir(itemType     , libraryDir     ) {
  const entry = registryEntry(itemType);
  if (!entry) return null;
  return path.join(resolveLiveuiLibraryRoot(libraryDir), entry.directory);
}

function atomicWriteLiveuiLibraryRecord(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const targetPath =
    typeof opts.targetPath === "string" && opts.targetPath
      ? path.resolve(opts.targetPath)
      : "";
  if (!targetPath || (targetPath !== libraryDir && !targetPath.startsWith(`${libraryDir}${path.sep}`))) {
    throw new Error("LiveUI Library atomic write target must be inside the Library root");
  }
  const directory = path.dirname(targetPath);
  if (opts.manageLibraryDir !== false || directory === libraryDir) {
    fs.mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(libraryDir, 0o700);
  }
  if (directory !== libraryDir) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const stem = path.basename(targetPath, ".json");
  const tempPath = path.join(directory, `.${stem}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${canonicalSerialize(opts.record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.chmodSync(tempPath, 0o600);
    if (opts.ifAbsent === true) {
      try {
        fs.linkSync(tempPath, targetPath);
        fs.unlinkSync(tempPath);
      } catch (err     ) {
        if (!err || err.code !== "EEXIST") throw err;
        return { status: "exists" };
      }
    } else {
      fs.renameSync(tempPath, targetPath);
    }
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch (_) {

    }
  }
  return { status: "written" };
}

function rejectedConflict(message     , currentDigest     ) {
  return {
    status: "rejected",
    code: "library_conflict",
    message,
    currentDigest: typeof currentDigest === "string" ? currentDigest : null,
  };
}

function safeDocumentName(documentName     ) {
  return typeof documentName === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(documentName)
    ? documentName
    : null;
}

function createLiveuiLibrary(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const manageLibraryDir = opts.manageLibraryDir !== false;
  const configuredDirectories =
    opts.typeDirectories && typeof opts.typeDirectories === "object"
      ? opts.typeDirectories
      : {};

  function typeEntry(itemType     ) {
    return registryEntry(itemType);
  }

  function typeDirectory(itemType     ) {
    const configured =
      typeof itemType === "string" &&
      Object.prototype.hasOwnProperty.call(configuredDirectories, itemType)
        ? Reflect.get(configuredDirectories, itemType)
        : null;
    if (typeof configured === "string" && configured.trim()) {
      return path.resolve(configured.trim());
    }
    const entry = typeEntry(itemType);
    return entry ? path.join(libraryDir, entry.directory) : null;
  }

  function itemPath(itemType     , itemId     ) {
    const directory = typeDirectory(itemType);
    return directory ? path.join(directory, `${itemId}.json`) : null;
  }

  function templateV2Directory() {
    if (typeof opts.templateV2Directory === "string" && opts.templateV2Directory.trim()) {
      return path.resolve(opts.templateV2Directory.trim());
    }
    return resolveLiveuiTemplateV2Dir(typeDirectory("template"));
  }

  function templateV2Path(itemId     ) {
    return path.join(templateV2Directory(), `${itemId}.json`);
  }

  function entryExists(targetPath     ) {
    try {
      fs.lstatSync(targetPath);
      return true;
    } catch (_) {
      return false;
    }
  }

  function documentPath(documentName     ) {
    const safeName = safeDocumentName(documentName);
    return safeName ? path.join(libraryDir, safeName) : null;
  }

  function atomicWriteRecord(targetPath     , record     , options      = {}) {
    return atomicWriteLiveuiLibraryRecord({
      fs,
      libraryDir,
      targetPath,
      record,
      manageLibraryDir,
      ifAbsent: options.ifAbsent === true,
    });
  }

  function recoveredMetadata(directory     , itemId     ) {
    if (!directory || !isValidLiveuiLibraryItemId(itemId)) return null;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(directory, `${itemId}.json`), "utf8"),
      );
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function ocuclawCard(itemId     ) {
    const digestInput = ocuclawCardDigestInput(itemId);
    if (!digestInput) return null;
    return { ...digestInput, digest: liveuiLibraryDigest(digestInput) };
  }

  function readOnlyCard(itemType     , itemId     ) {
    return {
      status: "rejected",
      code: "template_read_only",
      reason: "template_read_only",
      itemType,
      itemId,
      message: "OcuClaw's own cards are read-only",
    };
  }

  function cardHasValuesFile(itemId     ) {
    return entryExists(path.join(libraryDir, "template-values-v1", `${itemId}.json`)) ||
      entryExists(path.join(libraryDir, "template-values-v1", itemId));
  }

  function loadItem(itemType     , itemId     , options      = {}) {
    if (itemType === "template" && isOcuclawCardId(itemId) &&
        !(options && typeof options.directory === "string" && options.directory)) {
      return { status: "accepted", itemType, itemId, record: ocuclawCard(itemId) };
    }
    const lookup = lookupLiveuiLibraryItemType(itemType);
    const overrideDirectory =
      options && typeof options.directory === "string" && options.directory
        ? path.resolve(options.directory)
        : null;

    if (
      !overrideDirectory && itemType === "template" && lookup.status === "accepted" &&
      isValidLiveuiLibraryItemId(itemId)
    ) {
      const inV1 = entryExists(itemPath("template", itemId));
      const inV2 = entryExists(templateV2Path(itemId));
      if (inV1 && inV2) {
        return invalidProjection(
          itemType,
          itemId,
          "template_version_conflict",
          recoveredMetadata(templateV2Directory(), itemId),
        );
      }
      if (inV2) return loadItem(itemType, itemId, { directory: templateV2Directory() });
    }
    const directory = overrideDirectory || typeDirectory(itemType);
    if (lookup.status !== "accepted") {
      return invalidProjection(
        itemType,
        itemId,
        lookup.reason,
        recoveredMetadata(directory, itemId),
      );
    }
    if (!isValidLiveuiLibraryItemId(itemId)) {
      return invalidProjection(itemType, itemId, "item_id_invalid");
    }

    const targetPath = path.join(directory, `${itemId}.json`);
    let source;
    try {
      const stat = fs.lstatSync(targetPath);
      if (!stat.isFile()) return invalidProjection(itemType, itemId, "library_record_unreadable");
      source = fs.readFileSync(targetPath, "utf8");
    } catch (_) {
      return invalidProjection(itemType, itemId, "library_record_unreadable");
    }

    let record;
    try {
      record = JSON.parse(source);
    } catch (_) {
      return invalidProjection(itemType, itemId, "library_record_malformed");
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return invalidProjection(itemType, itemId, "library_record_malformed");
    }

    const entry = typeEntry(itemType);
    const templateV2 = itemType === "template" && path.resolve(directory) === templateV2Directory();
    const schemaVersion = templateV2 ? LIVEUI_TEMPLATE_V2_SCHEMA_VERSION : entry.schemaVersion;
    if (record.schemaVersion !== schemaVersion) {

      const newer = Number.isSafeInteger(record.schemaVersion) && record.schemaVersion > schemaVersion;
      return invalidProjection(itemType, itemId, newer ? "library_schema_unsupported" : "library_record_malformed", record);
    }
    if (
      record[entry.idField] !== itemId ||
      (record.itemType !== undefined && record.itemType !== itemType)
    ) {
      return invalidProjection(itemType, itemId, "library_identity_mismatch", record);
    }
    if (typeof record.digest !== "string" || !record.digest) {
      return invalidProjection(itemType, itemId, "library_digest_missing", record);
    }
    const { digest, ...digestInput } = record;
    if (digest !== liveuiLibraryDigest(digestInput)) {
      return invalidProjection(itemType, itemId, "library_digest_mismatch", record);
    }
    if (typeof record.name !== "string") {
      return invalidProjection(itemType, itemId, "library_record_malformed", record);
    }
    if (entry.maxBytes && savedBytes(record) > entry.maxBytes) {

      return invalidProjection(itemType, itemId, "library_record_malformed", record);
    }

    const shape = templateV2 ? LIVEUI_TEMPLATE_V2_SAVED_SHAPE : entry.shape;
    const known = shape ? knownFields(record, shape) : record;
    if (typeof entry.validateRecord === "function" && !entry.validateRecord(known)) {
      return invalidProjection(itemType, itemId, "library_record_malformed", record);
    }
    if (templateV2) {

      const checked      = validateLiveuiTemplateV2Record(known);
      if (!checked.ok) return invalidProjection(itemType, itemId, checked.code, record);
    }
    return { status: "accepted", itemType, itemId, record: known };
  }

  function wholeRecord(targetPath     ) {
    try {
      const record = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      const { digest, ...rest } = record;
      return typeof digest === "string" && digest === liveuiLibraryDigest(rest) ? { record, rest } : null;
    } catch (_) {
      return null;
    }
  }

  function carried(targetPath     , digestInput     , shape     , reads                         ) {
    if (!shape) return null;
    const before = wholeRecord(targetPath);
    if (!before || !hasUnknownFields(before.rest, shape)) return null;
    if (!reads(knownFields(before.record, shape))) return null;
    return carryUnknownFields(before.rest, digestInput, shape);
  }

  function savedInNewerForm(targetPath     , schemaVersion        ) {
    try {
      const record = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      return !!record && Number.isSafeInteger(record.schemaVersion) && record.schemaVersion > schemaVersion;
    } catch (_) {
      return false;
    }
  }

  function itemTypeFromDirectoryName(directoryName     ) {
    for (const entry of Object.values(LIVEUI_LIBRARY_ITEM_TYPES)) {
      if (entry.directory === directoryName) return entry.itemType;
    }
    const match = /^(.+)-v[0-9]+$/.exec(directoryName);
    if (!match) return null;
    const stem = match[1];
    return stem.endsWith("s") && stem.length > 1 ? stem.slice(0, -1) : stem;
  }

  function listItems(options      = {}) {
    const directories = new Map();
    for (const entry of Object.values(LIVEUI_LIBRARY_ITEM_TYPES)) {
      directories.set(path.resolve(typeDirectory(entry.itemType)), entry.itemType);
    }

    const templateV1Directory = path.resolve(typeDirectory("template"));
    const templateV2Dir = templateV2Directory();
    directories.set(templateV2Dir, "template");
    try {
      for (const entry of fs.readdirSync(libraryDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (LIVEUI_LIBRARY_METADATA_DIRS.has(entry.name)) continue;
        const itemType = itemTypeFromDirectoryName(entry.name);
        if (!itemType) continue;
        const directory = path.resolve(libraryDir, entry.name);
        if (!directories.has(directory)) directories.set(directory, itemType);
      }
    } catch (err     ) {
      if (!err || err.code !== "ENOENT") throw err;
    }

    const items      = [];
    for (const [directory, itemType] of directories.entries()) {
      let names;
      try {
        names = fs.readdirSync(directory);
      } catch (err     ) {
        if (err && err.code === "ENOENT") continue;
        throw err;
      }
      for (const name of names) {
        if (typeof name !== "string" || !name.endsWith(".json")) continue;
        const itemId = name.slice(0, -5);

        if (itemType === "template" && isOcuclawCardId(itemId)) continue;
        if (
          itemType === "template" &&
          (directory === templateV1Directory || directory === templateV2Dir) &&
          isValidLiveuiLibraryItemId(itemId) &&
          entryExists(itemPath("template", itemId)) &&
          entryExists(templateV2Path(itemId))
        ) {
          if (directory === templateV1Directory) {
            items.push(invalidProjection(
              "template",
              itemId,
              "template_version_conflict",
              recoveredMetadata(templateV2Dir, itemId),
            ));
          }
          continue;
        }
        const loaded = loadItem(itemType, itemId, { directory });
        if (loaded.status === "accepted") {
          const entry = typeEntry(itemType);

          const description = libraryDescription(liveuiTemplateRowDescription(loaded.record));
          items.push(
            typeof entry.projectRow === "function"
              ? entry.projectRow(loaded.record, options.executorStateProvider)
              : {
                  itemType,
                  itemId,
                  name: loaded.record.name,
                  ...(description ? { description } : {}),
                  digest: loaded.record.digest,
                  status: "ready",
                },
          );
        } else {
          items.push(loaded);
        }
      }
    }

    for (const cardId of OCUCLAW_CARD_IDS) {
      if (!cardHasValuesFile(cardId)) continue;
      const record      = ocuclawCard(cardId);
      const description = libraryDescription(liveuiTemplateRowDescription(record));
      items.push({
        itemType: "template",
        itemId: cardId,
        name: record.name,
        ...(description ? { description } : {}),
        digest: record.digest,
        status: "ready",
      });
    }
    const compare = (left     , right     ) => left < right ? -1 : left > right ? 1 : 0;
    items.sort(
      (left     , right     ) =>
        compare(left.itemType, right.itemType) || compare(left.itemId, right.itemId),
    );
    return { status: "accepted", items };
  }

  function loadDocument(documentName     , options      = {}) {
    const targetPath = documentPath(documentName);
    if (!targetPath) return { status: "invalid", reason: "library_document_name_invalid" };
    let source;
    try {
      const stat = fs.lstatSync(targetPath);
      if (!stat.isFile()) return { status: "invalid", reason: "library_document_unreadable" };
      source = fs.readFileSync(targetPath, "utf8");
    } catch (err     ) {
      if (err && err.code === "ENOENT" && options.defaultDigestInput) {
        const digestInput = options.defaultDigestInput;
        const record = JSON.parse(canonicalSerialize({
          ...digestInput,
          digest: liveuiLibraryDigest(digestInput),
        }));
        return { status: "accepted", record, virtual: true };
      }
      return { status: "invalid", reason: "library_document_unreadable" };
    }
    let record;
    try {
      record = JSON.parse(source);
    } catch (_) {
      return { status: "invalid", reason: "library_document_malformed" };
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      return { status: "invalid", reason: "library_document_malformed" };
    }
    if (typeof record.digest !== "string" || !record.digest) {
      return { status: "invalid", reason: "library_document_digest_missing" };
    }
    const { digest, ...digestInput } = record;
    if (digest !== liveuiLibraryDigest(digestInput)) {
      return { status: "invalid", reason: "library_document_digest_mismatch", digest };
    }

    const known = options.shape ? knownFields(record, options.shape) : record;
    if (typeof options.validateDocument === "function" && !options.validateDocument(known)) {
      return { status: "invalid", reason: "library_document_malformed", digest };
    }
    return { status: "accepted", record: known, virtual: false };
  }

  function saveDocument(documentName     , digestInput     , options      = {}) {
    const targetPath = documentPath(documentName);
    if (!targetPath) return { status: "invalid", reason: "library_document_name_invalid" };
    const expectedDigest = Object.prototype.hasOwnProperty.call(options, "expectedDigest")
      ? options.expectedDigest
      : undefined;
    if (expectedDigest !== undefined) {
      const current = loadDocument(documentName, options);
      if (current.status !== "accepted" || current.record.digest !== expectedDigest) {
        return rejectedConflict(
          "saved document changed since it was read",
          current.status === "accepted" ? current.record.digest : current.digest,
        );
      }
    }
    const record = JSON.parse(canonicalSerialize({
      ...digestInput,
      digest: liveuiLibraryDigest(digestInput),
    }));
    if (typeof options.validateDocument === "function" && !options.validateDocument(record)) {
      return { status: "invalid", reason: "library_document_malformed" };
    }
    const whole = carried(
      targetPath,
      digestInput,
      options.shape,
      (known) => typeof options.validateDocument !== "function" || !!options.validateDocument(known),
    );
    if (whole) {
      const kept = JSON.parse(canonicalSerialize({ ...whole, digest: liveuiLibraryDigest(whole) }));
      atomicWriteRecord(targetPath, kept);
      return { status: "saved", record: knownFields(kept, options.shape) };
    }
    atomicWriteRecord(targetPath, record);
    return { status: "saved", record };
  }

  function saveItem(itemType     , itemId     , digestInput     , options      = {}) {
    const lookup = lookupLiveuiLibraryItemType(itemType);
    if (lookup.status !== "accepted") return { ...lookup, itemId };
    if (!isValidLiveuiLibraryItemId(itemId)) {
      return invalidProjection(itemType, itemId, "item_id_invalid");
    }
    if (itemType === "template" && isOcuclawCardId(itemId)) return readOnlyCard(itemType, itemId);
    const entry = typeEntry(itemType);

    const templateV2 =
      itemType === "template" &&
      !!digestInput && typeof digestInput === "object" &&
      digestInput.schemaVersion === LIVEUI_TEMPLATE_V2_SCHEMA_VERSION;
    if (
      !digestInput ||
      typeof digestInput !== "object" ||
      Array.isArray(digestInput) ||
      digestInput.schemaVersion !== (templateV2 ? LIVEUI_TEMPLATE_V2_SCHEMA_VERSION : entry.schemaVersion) ||
      digestInput[entry.idField] !== itemId ||
      (digestInput.itemType !== undefined && digestInput.itemType !== itemType)
    ) {
      return invalidProjection(itemType, itemId, "library_identity_mismatch", digestInput);
    }

    const targetPath = templateV2 ? templateV2Path(itemId) : itemPath(itemType, itemId);

    const otherPath = itemType === "template"
      ? (templateV2 ? itemPath(itemType, itemId) : templateV2Path(itemId))
      : null;
    const otherExists = otherPath !== null && entryExists(otherPath);
    const expectedDigest =
      options && Object.prototype.hasOwnProperty.call(options, "expectedDigest")
        ? options.expectedDigest
        : undefined;
    const ifAbsent = options && options.ifAbsent === true;
    if (otherExists && (!templateV2 || ifAbsent)) {

      const current = loadItem(itemType, itemId);
      return rejectedConflict(
        ifAbsent ? "saved item already exists" : "saved item is a V2 template",
        current.status === "accepted" ? current.record.digest : current.digest,
      );
    }
    if (expectedDigest !== undefined) {
      let exists;
      try {
        exists = fs.existsSync(targetPath) || otherExists;
      } catch (_) {
        exists = false;
      }
      if (!exists) return rejectedConflict("saved item does not exist", null);
      const current = loadItem(itemType, itemId);
      const currentDigest =
        current.status === "accepted" ? current.record.digest : current.digest;
      if (current.status !== "accepted" || currentDigest !== expectedDigest) {
        return rejectedConflict("saved item changed since it was read", currentDigest);
      }
    }

    const record = JSON.parse(
      canonicalSerialize({ ...digestInput, digest: liveuiLibraryDigest(digestInput) }),
    );
    if (typeof entry.validateRecord === "function" && !entry.validateRecord(record)) {
      return invalidProjection(itemType, itemId, "library_record_malformed", record);
    }
    if (templateV2) {
      const checked      = validateLiveuiTemplateV2Record(record);
      if (!checked.ok) return invalidProjection(itemType, itemId, checked.code, record);
    }

    const formNumber = templateV2 ? LIVEUI_TEMPLATE_V2_SCHEMA_VERSION : entry.schemaVersion;
    const shape = templateV2 ? LIVEUI_TEMPLATE_V2_SAVED_SHAPE : entry.shape;
    if (!ifAbsent && savedInNewerForm(targetPath, formNumber)) {

      return invalidProjection(itemType, itemId, "library_schema_unsupported", record);
    }
    const whole = ifAbsent ? null : carried(
      targetPath,
      digestInput,
      shape,
      (known) =>
        known.schemaVersion === formNumber &&
        known[entry.idField] === itemId &&
        (typeof entry.validateRecord !== "function" || !!entry.validateRecord(known)) &&
        (!templateV2 || (validateLiveuiTemplateV2Record(known)       ).ok === true),
    );
    let saved = record;
    const kept = whole ? JSON.parse(canonicalSerialize({ ...whole, digest: liveuiLibraryDigest(whole) })) : null;

    const carryMaxBytes = options && Number.isSafeInteger(options.carryMaxBytes) ? options.carryMaxBytes : null;
    if (kept && !(carryMaxBytes !== null && savedBytes(kept) > carryMaxBytes)) {
      if (entry.maxBytes && savedBytes(kept) > entry.maxBytes) {

        return invalidProjection(itemType, itemId, "library_record_malformed", record);
      }
      atomicWriteRecord(targetPath, kept);
      saved = knownFields(kept, shape);
    } else {
      const write = atomicWriteRecord(targetPath, record, { ifAbsent });
      if (write.status === "exists") {
        const current = loadItem(itemType, itemId);
        const currentDigest =
          current.status === "accepted" ? current.record.digest : current.digest;
        return rejectedConflict("saved item already exists", currentDigest);
      }
    }
    if (templateV2 && otherExists) {

      try {
        fs.unlinkSync(otherPath);
      } catch (err     ) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }
    return { status: "saved", itemType, itemId, record: saved };
  }

  function deleteItem(itemType     , itemId     , options      = {}) {
    if (itemType === 'app') {
      const held = withProgramCardModelDeleteLease(libraryDir, () => deleteOwnedItem(itemType, itemId, options));
      return held.ok ? held.value : rejectedConflict('Models in cards is using this Library in another gateway. Turn it off there before deleting this card.', null);
    }
    return deleteOwnedItem(itemType, itemId, options);
  }
  function deleteOwnedItem(itemType     , itemId     , options      = {}) {
    if (itemType === "template" && isOcuclawCardId(itemId)) return readOnlyCard(itemType, itemId);
    const expectedDigest = options.expectedDigest;
    const targetPath = itemPath(itemType, itemId);
    const current = loadItem(itemType, itemId);
    let deletingInvalid = false;
    if (current.status !== "accepted") {
      const listed = listItems();
      deletingInvalid = listed.items.some(
        (item     ) =>
          item &&
          item.status === "invalid" &&
          item.itemType === itemType &&
          item.itemId === itemId,
      );

      const confirmed = deletingInvalid ? loadItem(itemType, itemId) : current;
      if (confirmed.status === "accepted") deletingInvalid = false;
    }
    if (
      (!deletingInvalid && current.status !== "accepted") ||
      (current.status === "accepted" && current.record.digest !== expectedDigest)
    ) {
      return rejectedConflict(
        "saved item changed since it was read",
        current.status === "accepted" ? current.record.digest : current.digest,
      );
    }

    if (itemType === 'app') markProgramCardModelDeleted(libraryDir, itemId);
    const targets = itemType === "template" ? [targetPath, templateV2Path(itemId)] : [targetPath];
    let removed = 0;
    for (const target of targets) {
      try {
        fs.unlinkSync(target);
        removed += 1;
      } catch (err     ) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }
    if (removed === 0) return rejectedConflict("saved item changed since it was read", null);

    if (itemType === "app") {
      for (const listener of cardDeleteListeners) if (listener.root === libraryDir) listener.callback(itemId);
      for (const filename of ["program-card-jev-v1.json", "program-card-mcp-v1.json", "program-card-model-v1.json"]) {
        const file = path.join(libraryDir, filename);
        let doc     ;
        try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (err     ) { if (err?.code === "ENOENT") continue; throw err; }
        if (Array.isArray(doc?.cards)) {
          doc.cards = doc.cards.filter((r     ) => r.key !== `app:${itemId}`);

          if (Array.isArray(doc.kept)) doc.kept = doc.kept.filter((r     ) => r?.key !== `app:${itemId}`);
          atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: doc });
        }
      }
      fs.rmSync(path.join(libraryDir, "program-card-model-threads-v1", itemId), { recursive: true, force: true });
      fs.rmSync(path.join(libraryDir, PROGRAM_CARD_REVISIONS_DIRECTORY, itemId), { recursive: true, force: true });
    }
    return {
      status: "deleted",
      itemType,
      itemId,
      ...(current.status === "accepted" ? { record: current.record } : {}),
    };
  }

  return {
    libraryDir,
    typeDirectory,
    templateV2Directory,
    loadItem,
    listItems,
    saveItem,
    deleteItem,
    loadDocument,
    saveDocument,
  };
}

module.exports = { LIVEUI_LIBRARY_ITEM_ID_RE, onProgramCardDeleted, TASK_SAVED_SHAPE, PROGRAM_CARD_REVISIONS_DIRECTORY, PROGRAM_CARD_REVIEWS_DIRECTORY, validateSettingValue, APP_SAVED_SHAPE, PROGRAM_CARD_ICON_BY, PROGRAM_CARD_REVISION_NUMBER_MAX, PROGRAM_CARD_NAME_MAX, PROGRAM_CARD_DESCRIPTION_MAX, PROGRAM_CARD_SOURCE_MAX, PROGRAM_CARD_STATE_MAX_BYTES, normalizeProgramCardAsks, validProgramCardName, normalizeProgramCardDescription, validProgramCardSpec, programCardStateBytes, PROGRAM_CARD_STATE_MAX_DEPTH, programCardStateDepthOk, validProgramCardRevisionNumber, programCardCurrentRevision, LIVEUI_LIBRARY_ITEM_TYPES, resolveLiveuiTemplateV2Dir, isValidLiveuiLibraryItemId, canonicalSerialize, liveuiLibraryDigest, liveuiLibraryItemKey, orderLiveuiLibraryItems, projectLiveuiLibraryForGlasses, lookupLiveuiLibraryItemType, resolveLiveuiLibraryRoot, resolveLiveuiLibraryTypeDir, atomicWriteLiveuiLibraryRecord, createLiveuiLibrary };
