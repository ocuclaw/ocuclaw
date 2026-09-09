const { createHash, randomUUID } = require("node:crypto");

const nodeFs = require("node:fs");

const { homedir } = require("node:os");

const path = require("node:path");

const LIVEUI_LIBRARY_ITEM_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
const TASK_ICON_RE = /^[a-z0-9._-]+$/;
const TASK_VERSION_ID_RE = /^v([1-9][0-9]*)$/;
const TASK_MAX_BYTES = 64 * 1024;

const LIVEUI_LIBRARY_METADATA_DIRS = new Set(["executors-v1", "task-runs-v1"]);

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validTaskSetting(setting) {
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
        (option) =>
          typeof option !== "string" || option.length > 64,
      )
    ) return false;
  } else if (setting.options !== undefined) {
    return false;
  }
  return true;
}

function validateSettingValue(contractEntry, value) {
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

function validTaskVersion(version) {
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
  if (new Set(version.settings.map((setting) => setting.key)).size !== version.settings.length) {
    return false;
  }
  if (
    version.approvedAtMs !== undefined &&
    (!Number.isSafeInteger(version.approvedAtMs) || version.approvedAtMs < 0)
  ) return false;
  return ["agent", "phone"].includes(version.authoredBy);
}

function validTaskRecord(record) {
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
  const versionNumbers = versions.map((version) => Number(version.versionId.slice(1)));
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
      approved ? approved.settings.map((setting) => [setting.key, setting]) : [],
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
  return new TextEncoder().encode(canonicalSerialize(record)).byteLength <= TASK_MAX_BYTES;
}

function projectTaskRow(record, executorStateProvider = null) {
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

const LIVEUI_LIBRARY_ITEM_TYPES = Object.freeze({
  template: Object.freeze({
    itemType: "template",
    directory: "templates-v1",
    schemaVersion: 1,
    idField: "templateId",
    supported: true,
  }),
  task: Object.freeze({
    itemType: "task",
    directory: "tasks-v1",
    schemaVersion: 1,
    idField: "taskId",
    supported: true,
    validateRecord: validTaskRecord,
    projectRow: projectTaskRow,
  }),
  app: Object.freeze({
    itemType: "app",
    directory: "apps-v1",
    schemaVersion: 1,
    idField: "appId",
    supported: false,
  }),
});

function isValidLiveuiLibraryItemId(itemId) {
  return typeof itemId === "string" && LIVEUI_LIBRARY_ITEM_ID_RE.test(itemId);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
  return output;
}

function canonicalSerialize(value) {
  return JSON.stringify(canonicalize(value));
}

function liveuiLibraryDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function liveuiLibraryItemKey(itemType, itemId) {
  return `${itemType}:${itemId}`;
}

function defaultLibraryItemOrder(left, right) {
  const leftRank = left.itemType === "template" ? 0 : left.itemType === "task" ? 1 : 2;
  const rightRank = right.itemType === "template" ? 0 : right.itemType === "task" ? 1 : 2;
  if (leftRank !== rightRank) return leftRank - rightRank;
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

function orderLiveuiLibraryItems(items, organization = null) {
  if (!Array.isArray(items)) return [];
  const byKey = new Map();
  for (const item of items) {
    if (!item || typeof item.itemType !== "string" || typeof item.itemId !== "string") continue;
    byKey.set(liveuiLibraryItemKey(item.itemType, item.itemId), item);
  }
  const ordered = [];
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

function libraryDescription(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 500) : "";
}

function projectLiveuiLibraryForGlasses(items, organization = null) {
  if (!Array.isArray(items)) return [];
  const hidden = new Set(
    organization && Array.isArray(organization.hidden) ? organization.hidden : [],
  );
  return orderLiveuiLibraryItems(items, organization)
    .filter((item) =>
      item &&
      (
        item.status === "ready" ||
        (item.itemType === "task" && ["needs_setup", "unavailable"].includes(item.status))
      ) &&
      !hidden.has(liveuiLibraryItemKey(item.itemType, item.itemId)),
    )
    .map((item) => ({
      itemType: item.itemType,
      itemId: item.itemId,
      name: item.name,
      status: item.status,
      ...(libraryDescription(item.description) ? { description: libraryDescription(item.description) } : {}),
      ...(["needs_setup", "unavailable"].includes(item.status) &&
        typeof item.reason === "string"
        ? { reason: item.reason }
        : {}),
    }));
}

function invalidProjection(itemType, itemId, reason, record = null) {
  const projection = {
    itemType: typeof itemType === "string" ? itemType : "",
    itemId: typeof itemId === "string" ? itemId : "",
    status: "invalid",
    reason,
  };
  if (record && typeof record.name === "string") projection.name = record.name;
  if (record && typeof record.digest === "string") projection.digest = record.digest;
  return projection;
}

function registryEntry(itemType) {
  if (
    typeof itemType !== "string" ||
    !Object.prototype.hasOwnProperty.call(LIVEUI_LIBRARY_ITEM_TYPES, itemType)
  ) {
    return null;
  }
  return Reflect.get(LIVEUI_LIBRARY_ITEM_TYPES, itemType);
}

function lookupLiveuiLibraryItemType(itemType) {
  const entry = registryEntry(itemType);
  if (!entry) return invalidProjection(itemType, "", "item_type_unknown");
  if (!entry.supported) return invalidProjection(itemType, "", "item_type_unsupported");
  return {
    status: "accepted",
    itemType: entry.itemType,
    directory: entry.directory,
  };
}

function resolveLiveuiLibraryRoot(libraryDir) {
  if (typeof libraryDir === "string" && libraryDir.trim()) {
    return path.resolve(libraryDir.trim());
  }
  return path.join(homedir(), ".ocuclaw", "liveui-library");
}

function resolveLiveuiLibraryTypeDir(itemType, libraryDir) {
  const entry = registryEntry(itemType);
  if (!entry) return null;
  return path.join(resolveLiveuiLibraryRoot(libraryDir), entry.directory);
}

function atomicWriteLiveuiLibraryRecord(opts = {}) {
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
      } catch (err) {
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

function rejectedConflict(message, currentDigest) {
  return {
    status: "rejected",
    code: "library_conflict",
    message,
    currentDigest: typeof currentDigest === "string" ? currentDigest : null,
  };
}

function safeDocumentName(documentName) {
  return typeof documentName === "string" &&
    /^[a-z0-9][a-z0-9._-]{0,127}\.json$/.test(documentName)
    ? documentName
    : null;
}

function createLiveuiLibrary(opts = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const manageLibraryDir = opts.manageLibraryDir !== false;
  const configuredDirectories =
    opts.typeDirectories && typeof opts.typeDirectories === "object"
      ? opts.typeDirectories
      : {};

  function typeEntry(itemType) {
    return registryEntry(itemType);
  }

  function typeDirectory(itemType) {
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

  function itemPath(itemType, itemId) {
    const directory = typeDirectory(itemType);
    return directory ? path.join(directory, `${itemId}.json`) : null;
  }

  function documentPath(documentName) {
    const safeName = safeDocumentName(documentName);
    return safeName ? path.join(libraryDir, safeName) : null;
  }

  function atomicWriteRecord(targetPath, record, options = {}) {
    return atomicWriteLiveuiLibraryRecord({
      fs,
      libraryDir,
      targetPath,
      record,
      manageLibraryDir,
      ifAbsent: options.ifAbsent === true,
    });
  }

  function recoveredMetadata(directory, itemId) {
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

  function loadItem(itemType, itemId, options = {}) {
    const lookup = lookupLiveuiLibraryItemType(itemType);
    const overrideDirectory =
      options && typeof options.directory === "string" && options.directory
        ? path.resolve(options.directory)
        : null;
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
    if (record.schemaVersion !== entry.schemaVersion) {
      return invalidProjection(itemType, itemId, "library_schema_unsupported", record);
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
    if (typeof entry.validateRecord === "function" && !entry.validateRecord(record)) {
      return invalidProjection(itemType, itemId, "library_record_malformed", record);
    }
    return { status: "accepted", itemType, itemId, record };
  }

  function itemTypeFromDirectoryName(directoryName) {
    for (const entry of Object.values(LIVEUI_LIBRARY_ITEM_TYPES)) {
      if (entry.directory === directoryName) return entry.itemType;
    }
    const match = /^(.+)-v[0-9]+$/.exec(directoryName);
    if (!match) return null;
    const stem = match[1];
    return stem.endsWith("s") && stem.length > 1 ? stem.slice(0, -1) : stem;
  }

  function listItems(options = {}) {
    const directories = new Map();
    for (const entry of Object.values(LIVEUI_LIBRARY_ITEM_TYPES)) {
      directories.set(path.resolve(typeDirectory(entry.itemType)), entry.itemType);
    }
    try {
      for (const entry of fs.readdirSync(libraryDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (LIVEUI_LIBRARY_METADATA_DIRS.has(entry.name)) continue;
        const itemType = itemTypeFromDirectoryName(entry.name);
        if (!itemType) continue;
        const directory = path.resolve(libraryDir, entry.name);
        if (!directories.has(directory)) directories.set(directory, itemType);
      }
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
    }

    const items = [];
    for (const [directory, itemType] of directories.entries()) {
      let names;
      try {
        names = fs.readdirSync(directory);
      } catch (err) {
        if (err && err.code === "ENOENT") continue;
        throw err;
      }
      for (const name of names) {
        if (typeof name !== "string" || !name.endsWith(".json")) continue;
        const itemId = name.slice(0, -5);
        const loaded = loadItem(itemType, itemId, { directory });
        if (loaded.status === "accepted") {
          const entry = typeEntry(itemType);
          items.push(
            typeof entry.projectRow === "function"
              ? entry.projectRow(loaded.record, options.executorStateProvider)
              : {
                  itemType,
                  itemId,
                  name: loaded.record.name,
                  ...(libraryDescription(loaded.record.fields?.body || loaded.record.defaults?.body || loaded.record.defaults?.title)
                    ? { description: libraryDescription(loaded.record.fields?.body || loaded.record.defaults?.body || loaded.record.defaults?.title) }
                    : {}),
                  digest: loaded.record.digest,
                  status: "ready",
                },
          );
        } else {
          items.push(loaded);
        }
      }
    }
    const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
    items.sort(
      (left, right) =>
        compare(left.itemType, right.itemType) || compare(left.itemId, right.itemId),
    );
    return { status: "accepted", items };
  }

  function loadDocument(documentName, options = {}) {
    const targetPath = documentPath(documentName);
    if (!targetPath) return { status: "invalid", reason: "library_document_name_invalid" };
    let source;
    try {
      const stat = fs.lstatSync(targetPath);
      if (!stat.isFile()) return { status: "invalid", reason: "library_document_unreadable" };
      source = fs.readFileSync(targetPath, "utf8");
    } catch (err) {
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
    if (typeof options.validateDocument === "function" && !options.validateDocument(record)) {
      return { status: "invalid", reason: "library_document_malformed", digest };
    }
    return { status: "accepted", record, virtual: false };
  }

  function saveDocument(documentName, digestInput, options = {}) {
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
    atomicWriteRecord(targetPath, record);
    return { status: "saved", record };
  }

  function saveItem(itemType, itemId, digestInput, options = {}) {
    const lookup = lookupLiveuiLibraryItemType(itemType);
    if (lookup.status !== "accepted") return { ...lookup, itemId };
    if (!isValidLiveuiLibraryItemId(itemId)) {
      return invalidProjection(itemType, itemId, "item_id_invalid");
    }
    const entry = typeEntry(itemType);
    if (
      !digestInput ||
      typeof digestInput !== "object" ||
      Array.isArray(digestInput) ||
      digestInput.schemaVersion !== entry.schemaVersion ||
      digestInput[entry.idField] !== itemId ||
      (digestInput.itemType !== undefined && digestInput.itemType !== itemType)
    ) {
      return invalidProjection(itemType, itemId, "library_identity_mismatch", digestInput);
    }

    const targetPath = itemPath(itemType, itemId);
    const expectedDigest =
      options && Object.prototype.hasOwnProperty.call(options, "expectedDigest")
        ? options.expectedDigest
        : undefined;
    const ifAbsent = options && options.ifAbsent === true;
    if (expectedDigest !== undefined) {
      let exists;
      try {
        exists = fs.existsSync(targetPath);
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
    const write = atomicWriteRecord(targetPath, record, { ifAbsent });
    if (write.status === "exists") {
      const current = loadItem(itemType, itemId);
      const currentDigest =
        current.status === "accepted" ? current.record.digest : current.digest;
      return rejectedConflict("saved item already exists", currentDigest);
    }
    return { status: "saved", itemType, itemId, record };
  }

  function deleteItem(itemType, itemId, options = {}) {
    const expectedDigest = options.expectedDigest;
    const targetPath = itemPath(itemType, itemId);
    const current = loadItem(itemType, itemId);
    let deletingInvalid = false;
    if (current.status !== "accepted") {
      const listed = listItems();
      deletingInvalid = listed.items.some(
        (item) =>
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
    try {
      fs.unlinkSync(targetPath);
    } catch (err) {
      if (!err || err.code !== "ENOENT") throw err;
      return rejectedConflict("saved item changed since it was read", null);
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
    loadItem,
    listItems,
    saveItem,
    deleteItem,
    loadDocument,
    saveDocument,
  };
}

module.exports = { LIVEUI_LIBRARY_ITEM_ID_RE, LIVEUI_LIBRARY_ITEM_TYPES, isValidLiveuiLibraryItemId, canonicalSerialize, liveuiLibraryDigest, liveuiLibraryItemKey, orderLiveuiLibraryItems, projectLiveuiLibraryForGlasses, lookupLiveuiLibraryItemType, resolveLiveuiLibraryRoot, resolveLiveuiLibraryTypeDir, atomicWriteLiveuiLibraryRecord, validateSettingValue, createLiveuiLibrary };
