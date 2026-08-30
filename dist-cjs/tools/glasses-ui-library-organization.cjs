const { LIVEUI_LIBRARY_ITEM_TYPES, createLiveuiLibrary, isValidLiveuiLibraryItemId, liveuiLibraryDigest, liveuiLibraryItemKey, orderLiveuiLibraryItems, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const LIVEUI_LIBRARY_ORGANIZATION_SCHEMA_VERSION = 1;
const LIVEUI_LIBRARY_ORGANIZATION_FILENAME = "organization-v1.json";

const ORGANIZATION_KEYS = new Set(["schemaVersion", "order", "hidden", "digest"]);
const ITEM_TYPE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isValidLiveuiLibraryItemKey(value) {
  if (typeof value !== "string") return false;
  const separator = value.indexOf(":");
  if (separator < 1 || separator !== value.lastIndexOf(":")) return false;
  return ITEM_TYPE_RE.test(value.slice(0, separator)) &&
    isValidLiveuiLibraryItemId(value.slice(separator + 1));
}

function validUniqueKeyArray(value) {
  return Array.isArray(value) &&
    value.every(isValidLiveuiLibraryItemKey) &&
    new Set(value).size === value.length;
}

function validateOrganizationRecord(record) {
  return !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    hasOnlyKeys(record, ORGANIZATION_KEYS) &&
    record.schemaVersion === LIVEUI_LIBRARY_ORGANIZATION_SCHEMA_VERSION &&
    validUniqueKeyArray(record.order) &&
    validUniqueKeyArray(record.hidden) &&
    typeof record.digest === "string" &&
    !!record.digest;
}

function defaultOrganizationInput() {
  return {
    schemaVersion: LIVEUI_LIBRARY_ORGANIZATION_SCHEMA_VERSION,
    order: [],
    hidden: [],
  };
}

function rejected(code, message, currentDigest = undefined) {
  return {
    status: "rejected",
    code,
    message,
    ...(currentDigest === undefined ? {} : { currentDigest }),
  };
}

function createLiveuiLibraryOrganization(opts = {}) {
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const library = createLiveuiLibrary({ libraryDir, ...(opts.fs ? { fs: opts.fs } : {}) });
  const documentOptions = {
    defaultDigestInput: defaultOrganizationInput(),
    validateDocument: validateOrganizationRecord,
  };

  function load() {
    const loaded = library.loadDocument(
      LIVEUI_LIBRARY_ORGANIZATION_FILENAME,
      documentOptions,
    );
    if (loaded.status === "accepted") {
      return { status: "accepted", organization: loaded.record };
    }
    const digestInput = defaultOrganizationInput();
    return {
      status: "accepted",
      organization: { ...digestInput, digest: liveuiLibraryDigest(digestInput) },
      organizationInvalid: loaded.reason || "library_document_malformed",
    };
  }

  function loadForWrite(expectedDigest) {
    if (typeof expectedDigest !== "string" || !expectedDigest) {
      return rejected("library_conflict", "expectedDigest is required", null);
    }
    const current = load();
    if (current.organizationInvalid) {
      return rejected(
        "library_organization_invalid",
        `Library organization is invalid: ${current.organizationInvalid}`,
        null,
      );
    }
    if (current.organization.digest !== expectedDigest) {
      return rejected(
        "library_conflict",
        "saved document changed since it was read",
        current.organization.digest,
      );
    }
    return current;
  }

  function save(current, patch) {
    const digestInput = {
      schemaVersion: LIVEUI_LIBRARY_ORGANIZATION_SCHEMA_VERSION,
      order: patch.order || current.order,
      hidden: patch.hidden || current.hidden,
    };
    const saved = library.saveDocument(
      LIVEUI_LIBRARY_ORGANIZATION_FILENAME,
      digestInput,
      { ...documentOptions, expectedDigest: current.digest },
    );
    if (saved.status !== "saved") return saved;
    return { status: "saved", organization: saved.record };
  }

  return {
    libraryDir,
    load,
    reorderLibrary(input = {}) {
      const current = loadForWrite(input.expectedDigest);
      if (current.status !== "accepted") return current;
      if (!validUniqueKeyArray(input.order)) {
        return rejected("library_order_invalid", "order must contain unique Library item keys");
      }
      return save(current.organization, { order: input.order.slice() });
    },
    setLibraryItemHidden(input = {}) {
      const current = loadForWrite(input.expectedDigest);
      if (current.status !== "accepted") return current;
      const key = liveuiLibraryItemKey(input.itemType, input.itemId);
      if (!isValidLiveuiLibraryItemKey(key) || typeof input.hidden !== "boolean") {
        return rejected("library_item_invalid", "itemType, itemId, and hidden are required");
      }
      const hidden = current.organization.hidden.filter((entry) => entry !== key);
      if (input.hidden) hidden.push(key);
      return save(current.organization, { hidden });
    },
    hideLibraryItemForHelper(itemKey) {
      if (!isValidLiveuiLibraryItemKey(itemKey)) {
        return rejected("library_item_invalid", "helper itemKey is invalid");
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = load();
        if (current.organizationInvalid) {
          return rejected(
            "library_organization_invalid",
            `Library organization is invalid: ${current.organizationInvalid}`,
          );
        }
        if (current.organization.hidden.includes(itemKey)) {
          return { status: "saved", organization: current.organization };
        }
        const saved = save(current.organization, {
          hidden: [...current.organization.hidden, itemKey],
        });
        if (!(saved.status === "rejected" && saved.code === "library_conflict")) return saved;
      }
      return rejected("library_conflict", "Library organization changed while hiding helper");
    },
    removeLibraryItem(itemType, itemId) {
      const key = liveuiLibraryItemKey(itemType, itemId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = load();
        if (current.organizationInvalid) {
          return rejected(
            "library_organization_invalid",
            `Library organization is invalid: ${current.organizationInvalid}`,
          );
        }
        const order = current.organization.order.filter((entry) => entry !== key);
        const hidden = current.organization.hidden.filter((entry) => entry !== key);
        if (
          order.length === current.organization.order.length &&
          hidden.length === current.organization.hidden.length
        ) {
          return { status: "saved", organization: current.organization };
        }
        const saved = save(current.organization, { order, hidden });
        if (!(saved.status === "rejected" && saved.code === "library_conflict")) return saved;
      }
      return rejected("library_conflict", "Library organization changed during deletion");
    },
  };
}

function normalizedVisibleName(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : "";
}

function findLiveuiVisibleNameClash(
  items,
  organization,
  candidate,
) {
  const candidateName = normalizedVisibleName(candidate && candidate.name);
  const candidateKey = liveuiLibraryItemKey(candidate && candidate.itemType, candidate && candidate.itemId);
  if (!candidateName || !Array.isArray(items)) return null;
  const hidden = new Set(
    organization && Array.isArray(organization.hidden) ? organization.hidden : [],
  );
  for (const item of orderLiveuiLibraryItems(items, organization)) {
    if (!item || item.status !== "ready") continue;
    const key = liveuiLibraryItemKey(item.itemType, item.itemId);
    if (key === candidateKey || hidden.has(key)) continue;
    if (normalizedVisibleName(item.name) === candidateName) return item;
  }
  return null;
}

function rejectLiveuiVisibleNameClash(clash) {
  const itemType = clash && typeof clash.itemType === "string" ? clash.itemType : "item";
  const name = clash && typeof clash.name === "string" ? clash.name : "another item";
  return rejected(
    "library_name_clash",
    `Visible name clashes with ${itemType} \"${name}\". Rename or hide it first.`,
  );
}

function isLiveuiLibraryItemVisible(organization, itemType, itemId) {
  const hidden = organization && Array.isArray(organization.hidden)
    ? organization.hidden
    : [];
  return !hidden.includes(liveuiLibraryItemKey(itemType, itemId));
}

function isSupportedLiveuiLibraryItemType(itemType) {
  return typeof itemType === "string" &&
    Object.prototype.hasOwnProperty.call(LIVEUI_LIBRARY_ITEM_TYPES, itemType);
}

module.exports = { LIVEUI_LIBRARY_ORGANIZATION_SCHEMA_VERSION, LIVEUI_LIBRARY_ORGANIZATION_FILENAME, isValidLiveuiLibraryItemKey, createLiveuiLibraryOrganization, findLiveuiVisibleNameClash, rejectLiveuiVisibleNameClash, isLiveuiLibraryItemVisible, isSupportedLiveuiLibraryItemType };
