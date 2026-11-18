const nodeFs = require("node:fs");

const path = require("node:path");
const { PROGRAM_CARD_REVISIONS_DIRECTORY, PROGRAM_CARD_STATE_MAX_BYTES, atomicWriteLiveuiLibraryRecord, isValidLiveuiLibraryItemId, programCardStateBytes, programCardStateDepthOk, resolveLiveuiLibraryRoot, validProgramCardRevisionNumber } = require("./glasses-ui-library.cjs");
const { carryUnknownFields, hasUnknownFields, knownFields } = require("./saved-format.cjs");

const PROGRAM_CARD_SLOTS_FILE = "slots.json";

const PROGRAM_CARD_SLOTS_MAX = 3;

const PROGRAM_CARD_SLOT_LABEL_MAX = 40;
const SLOTS_SCHEMA_VERSION = 1;
const SLOTS_FILE_KEYS = new Set(["schemaVersion", "appId", "slots"]);
const SLOT_KEYS = new Set(["slot", "label", "state", "revision", "sourceHash", "savedAtMs"]);

const PROGRAM_CARD_SLOTS_SAVED_SHAPE             = Object.freeze({
  fields: [...SLOTS_FILE_KEYS],
  lists: { slots: { by: "slot", fields: [...SLOT_KEYS], replaced: true } },
});
const SOURCE_HASH_RE = /^sha256:[0-9a-f]{64}$/;

function hasOnlyKeys(value     , allowed     ) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function plainObject(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function programCardSlotNumber(value     ) {
  return Number.isSafeInteger(value) && value >= 1 && value <= PROGRAM_CARD_SLOTS_MAX ? value : null;
}

function normalizeProgramCardSlotLabel(label     ) {
  if (typeof label !== "string") return null;

  return foldedSlotLabel(label.replace(SLOT_LABEL_CONTROLS, " "));
}

const SLOT_LABEL_CONTROLS = /[\u0000-\u001f\u007f-\u009f؜​‎‏‪-‮⁠⁦-⁩﻿]/g;

function foldedSlotLabel(label        ) {
  const line = label.replace(/\s+/g, " ").trim();
  if (!line) return null;
  const chars = Array.from(line);
  return chars.length > PROGRAM_CARD_SLOT_LABEL_MAX
    ? chars.slice(0, PROGRAM_CARD_SLOT_LABEL_MAX).join("").trimEnd()
    : line;
}

function validSlot(slot     ) {
  if (!plainObject(slot) || !hasOnlyKeys(slot, SLOT_KEYS)) return false;
  if (programCardSlotNumber(slot.slot) === null) return false;
  if (slot.label !== undefined && (typeof slot.label !== "string" || foldedSlotLabel(slot.label) !== slot.label)) return false;
  const bytes = programCardStateBytes(slot.state);
  if (bytes < 0 || bytes > PROGRAM_CARD_STATE_MAX_BYTES) return false;
  if (!validProgramCardRevisionNumber(slot.revision)) return false;
  if (typeof slot.sourceHash !== "string" || !SOURCE_HASH_RE.test(slot.sourceHash)) return false;
  return Number.isSafeInteger(slot.savedAtMs) && slot.savedAtMs >= 0;
}

function validProgramCardSlotsFile(record     , appId     ) {
  if (!plainObject(record) || !hasOnlyKeys(record, SLOTS_FILE_KEYS)) return false;
  if (record.schemaVersion !== SLOTS_SCHEMA_VERSION || record.appId !== appId) return false;
  if (!Array.isArray(record.slots) || record.slots.length > PROGRAM_CARD_SLOTS_MAX) return false;
  const seen = new Set();
  for (const slot of record.slots) {
    if (!validSlot(slot) || seen.has(slot.slot)) return false;
    seen.add(slot.slot);
  }
  return true;
}

function slotRow(slot     ) {

  const label = normalizeProgramCardSlotLabel(slot.label);
  return {
    slot: slot.slot,
    ...(label ? { label } : {}),
    revision: slot.revision,
    savedAtMs: slot.savedAtMs,
  };
}

function createProgramCardSlots(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const root = path.join(libraryDir, PROGRAM_CARD_REVISIONS_DIRECTORY);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  function nowMs() {
    const value = Number(now());
    return Number.isSafeInteger(value) ? value : Date.now();
  }

  function slotsPath(appId     ) {
    return isValidLiveuiLibraryItemId(appId) ? path.join(root, appId, PROGRAM_CARD_SLOTS_FILE) : null;
  }

  function whole(target     ) {
    try {
      return JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (_) {
      return null;
    }
  }

  function read(appId     )        {
    const target = slotsPath(appId);
    if (!target) return [];

    const record = knownFields(whole(target), PROGRAM_CARD_SLOTS_SAVED_SHAPE);
    if (!validProgramCardSlotsFile(record, appId)) return [];
    return record.slots.slice().sort((a     , b     ) => a.slot - b.slot);
  }

  function write(appId     , slots       ) {
    const target = slotsPath(appId);
    if (!target) return false;
    if (!slots.length) {
      remove(appId);
      return true;
    }
    const record = {
      schemaVersion: SLOTS_SCHEMA_VERSION,
      appId,
      slots: slots.slice().sort((a     , b     ) => a.slot - b.slot),
    };

    const before = whole(target);
    const kept = validProgramCardSlotsFile(knownFields(before, PROGRAM_CARD_SLOTS_SAVED_SHAPE), appId) &&
      hasUnknownFields(before, PROGRAM_CARD_SLOTS_SAVED_SHAPE)
      ? carryUnknownFields(before, record, PROGRAM_CARD_SLOTS_SAVED_SHAPE)
      : record;
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: target, record: kept });
    return true;
  }

  function list(appId     ) {
    return read(appId).map(slotRow);
  }

  function save(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const slot = programCardSlotNumber(params.slot);
    const reject = (code        ) => ({ status: "rejected", code, appId, ...(slot !== null ? { slot } : {}) });
    if (slot === null) return reject("slot_invalid");
    const current = params.current;
    if (!current || !isValidLiveuiLibraryItemId(appId)) return reject("app_not_found");
    const bytes = programCardStateBytes(params.state);
    if (bytes < 0) return reject("state_invalid");
    if (bytes > PROGRAM_CARD_STATE_MAX_BYTES) return reject("state_too_large");
    if (!programCardStateDepthOk(params.state)) return reject("state_invalid");
    if (params.revision !== current.revision || params.sourceHash !== current.sourceHash) return reject("saved_base_conflict");
    const slots = read(appId);
    const filled = slots.find((entry     ) => entry.slot === slot);
    if (filled && params.replace !== true) return reject("slot_full");
    const label = normalizeProgramCardSlotLabel(params.label);
    const entry = {
      slot,
      ...(label ? { label } : {}),
      state: params.state,
      revision: current.revision,
      sourceHash: current.sourceHash,
      savedAtMs: nowMs(),
    };
    write(appId, [...slots.filter((other     ) => other.slot !== slot), entry]);
    return { status: "saved", appId, ...slotRow(entry) };
  }

  function load(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const slot = programCardSlotNumber(params.slot);
    const reject = (code        ) => ({ status: "rejected", code, appId, ...(slot !== null ? { slot } : {}) });
    if (slot === null) return reject("slot_invalid");
    const current = params.current;
    if (!current || !isValidLiveuiLibraryItemId(appId)) return reject("app_not_found");
    const entry = read(appId).find((other     ) => other.slot === slot);
    if (!entry) return reject("slot_empty");
    return {
      status: "accepted",
      appId,
      ...slotRow(entry),
      state: entry.state,
      sourceHash: entry.sourceHash,
      migrate: entry.sourceHash !== current.sourceHash,
    };
  }

  function deleteSlot(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const slot = programCardSlotNumber(params.slot);
    const reject = (code        ) => ({ status: "rejected", code, appId, ...(slot !== null ? { slot } : {}) });
    if (slot === null) return reject("slot_invalid");
    if (!params.current || !isValidLiveuiLibraryItemId(appId)) return reject("app_not_found");
    const slots = read(appId);
    if (!slots.some((entry     ) => entry.slot === slot)) return reject("slot_empty");
    write(appId, slots.filter((entry     ) => entry.slot !== slot));
    return { status: "deleted", appId, slot };
  }

  function remove(appId     ) {
    const target = slotsPath(appId);
    if (!target) return;
    try {
      fs.unlinkSync(target);
    } catch (err     ) {
      if (!err || err.code !== "ENOENT") throw err;
    }
  }

  return { libraryDir, list, save, load, delete: deleteSlot, remove };
}

function programCardSlotsCurrent(source     ) {
  if (!source || source.status !== "accepted") return null;
  return validProgramCardRevisionNumber(source.revision) && typeof source.sourceHash === "string"
    ? { revision: source.revision, sourceHash: source.sourceHash }
    : null;
}

function createProgramCardSlotHandlers({ saves, slots, canAccess }     ) {
  const access = (clientId     , appId     ) => typeof canAccess !== "function" || canAccess(clientId, appId) === true;
  const currentOf = (appId     ) => programCardSlotsCurrent(saves.source({ appId }));
  return {
    onGetProgramCardSlots({ clientId, appId }     ) {
      if (!access(clientId, appId)) return { status: "rejected", code: "presentation_owner_changed", appId };
      if (!currentOf(appId)) return { status: "rejected", code: "app_not_found", appId };
      return { status: "accepted", appId, slots: slots.list(appId) };
    },
    onProgramCardSlot({ clientId, action, appId, slot, state, revision, sourceHash, label, replace }     ) {
      if (!access(clientId, appId)) return { status: "rejected", code: "presentation_owner_changed", appId };
      const current = currentOf(appId);
      if (action === "save") return slots.save({ appId, slot, state, revision, sourceHash, label, replace, current });
      if (action === "load") return slots.load({ appId, slot, current });
      if (action === "delete") return slots.delete({ appId, slot, current });
      return { status: "rejected", code: "action_invalid", appId };
    },
  };
}

module.exports = { PROGRAM_CARD_SLOTS_FILE, PROGRAM_CARD_SLOTS_MAX, PROGRAM_CARD_SLOT_LABEL_MAX, PROGRAM_CARD_SLOTS_SAVED_SHAPE, programCardSlotNumber, normalizeProgramCardSlotLabel, validProgramCardSlotsFile, createProgramCardSlots, programCardSlotsCurrent, createProgramCardSlotHandlers };
