const { randomBytes } = require("node:crypto");
const { relaySessionKeyFor } = require("../runtime/openclaw-session-key.cjs");
const { LIVEUI_LIBRARY_ITEM_ID_RE, PROGRAM_CARD_STATE_MAX_BYTES, createLiveuiLibrary, PROGRAM_CARD_ICON_BY, isValidLiveuiLibraryItemId, normalizeProgramCardDescription, normalizeProgramCardAsks, programCardCurrentRevision, liveuiLibraryDigest, programCardStateBytes, programCardStateDepthOk, validProgramCardName, validProgramCardRevisionNumber, validProgramCardSpec } = require("./glasses-ui-library.cjs");
const { createProgramCardRevisions, normalizeProgramCardRevisionBy, normalizeProgramCardRevisionNote, normalizeProgramCardRevisionStarter } = require("./program-card-revisions.cjs");
const { TASK_SLOT_FIRST, normalizeTaskSlots, taskSlotsCap } = require("./glasses-ui-task-slots.cjs");
const { programCardKitLevelValue } = require("./program-card-kit-check.cjs");

const PROGRAM_CARD_ITEM_TYPE = "app";

const PROGRAM_CARD_SAVE_MODES = Object.freeze(["revision", "replace", "new"]);
const PROGRAM_CARD_REQUEST_ID_MAX = 64;
const PROGRAM_CARD_ERROR_CODE_MAX = 64;
const PROGRAM_CARD_SLUG_MAX = 40;
const PROGRAM_CARD_SAVE_REQUEST_TIMEOUT_MS = 10_000;

const PROGRAM_CARD_REVISIONS_PICTURES_MAX = 512 * 1024;

const NEW_ID_ATTEMPTS = 8;

function defaultRandom() {

  return randomBytes(4).readUInt32BE(0) / 0x100000000;
}

function programCardSlug(name     ) {
  const slug = String(typeof name === "string" ? name : "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROGRAM_CARD_SLUG_MAX)
    .replace(/-+$/g, "");
  return slug || "card";
}

function randomSuffix(random     ) {
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    const value = Number(random());
    const digit = Number.isFinite(value) ? Math.floor(Math.min(Math.max(value, 0), 0.999999) * 36) : 0;
    out += digit.toString(36);
  }
  return out;
}

function normalizeProgramCardErrorCode(error     ) {
  if (typeof error !== "string") return "save_failed";
  const code = error.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, PROGRAM_CARD_ERROR_CODE_MAX);
  return code || "save_failed";
}

function stateRejection(state     ) {
  const bytes = programCardStateBytes(state);
  if (bytes < 0) return "state_invalid";
  if (bytes > PROGRAM_CARD_STATE_MAX_BYTES) return "state_too_large";

  if (!programCardStateDepthOk(state)) return "state_invalid";
  return null;
}

function createProgramCardSaves(opts      = {}) {
  const library = createLiveuiLibrary({ libraryDir: opts.libraryDir, fs: opts.fs });
  const revisions = createProgramCardRevisions({ libraryDir: library.libraryDir, fs: opts.fs });
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const random = typeof opts.random === "function" ? opts.random : defaultRandom;

  const slotsCap = () => taskSlotsCap(typeof opts.taskSlotsCap === "function" ? opts.taskSlotsCap() : opts.taskSlotsCap);

  const keepRevisions = (appId        )           => {
    const kept = typeof opts.keepRevisions === "function" ? opts.keepRevisions(appId) : null;
    return Array.isArray(kept) ? kept.filter((number     ) => validProgramCardRevisionNumber(number)) : [];
  };

  const kitLevel = () => {
    try { return programCardKitLevelValue(typeof opts.kitLevel === "function" ? opts.kitLevel() : opts.kitLevel); }
    catch (_) { return null; }
  };
  const kitValue = (kit     )                           => {
    const level = programCardKitLevelValue(kit?.level);
    return level === null ? null : { level };
  };

  const writeKit = (appId     , number     , kit                          ) => {
    if (!kit) return;
    try { revisions.noteKit(appId, number, kit.level); } catch (_) {  }
  };

  const stampKit = (appId     , number     ) => writeKit(appId, number, kitValue({ level: kitLevel() }));

  const derivedKit = (from     , changed         , also      = null)                           => {
    const kept = kitValue(from);
    if (!changed) return kept;
    const levels = [kept, kitValue(also), kitValue({ level: kitLevel() })].filter(Boolean).map((kit     ) => kit.level);
    return levels.length ? { level: Math.max(...levels) } : null;
  };
  function nowMs() {
    const value = Number(now());
    return Number.isSafeInteger(value) ? value : Date.now();
  }

  function load(appId     ) {
    if (!isValidLiveuiLibraryItemId(appId)) {
      return { status: "rejected", code: "app_not_found", appId: typeof appId === "string" ? appId : "" };
    }
    const loaded      = library.loadItem(PROGRAM_CARD_ITEM_TYPE, appId);
    if (!loaded || loaded.status !== "accepted") {
      return { status: "rejected", code: "app_not_found", appId };
    }
    return { status: "accepted", appId, record: loaded.record };
  }

  function writeRecord(appId     , digestInput     , options      = {}) {
    return library.saveItem(PROGRAM_CARD_ITEM_TYPE, appId, digestInput, options);
  }

  function create(appIdIn     , fields     , options      = {}) {
    const { name, card, state, savedAtMs, by, note, description, asks, taskSlots, starter } = fields;
    const writeNew = (appId     , number     , writeOptions     ) => {
      if (typeof options.beforeCreate === "function" && options.beforeCreate(appId) !== true)
        return { status: "rejected", code: "presentation_owner_changed" };
      return writeRecord(appId, {
      schemaVersion: 1,
      itemType: PROGRAM_CARD_ITEM_TYPE,
      appId,
      name,
      card,
      checkpoint: { seq: 0, state, savedAtMs },
      createdAtMs: savedAtMs,
      revision: number,
      ...(description ? { cosmetic: { description } } : {}),
      ...(asks ? { asks } : {}),
      ...(taskSlots ? { taskSlots } : {}),
      }, writeOptions);
    };
    const firstRevision = (appId     , number     , written     ) => {

      revisions.write(appId, { number, name, card, state, savedAtMs, by, note, taskSlots, ...(starter ? { starter } : {}) });

      if (fields.kit === undefined) stampKit(appId, number);
      else writeKit(appId, number, kitValue(fields.kit));
      return { status: "saved", appId, name, record: written.record, revision: number };
    };
    if (appIdIn) {
      const number = Math.max(0, ...revisions.numbers(appIdIn)) + 1;
      if (!validProgramCardRevisionNumber(number)) return null;
      const written      = writeNew(appIdIn, number, options);
      return written && written.status === "saved" ? firstRevision(appIdIn, number, written) : null;
    }
    for (let attempt = 0; attempt < NEW_ID_ATTEMPTS; attempt += 1) {
      const appId = `${programCardSlug(name)}-${randomSuffix(random)}`;
      if (!LIVEUI_LIBRARY_ITEM_ID_RE.test(appId)) return null;
      const written      = writeNew(appId, 1, { ifAbsent: true });
      if (written && written.status === "saved") {
        revisions.clear(appId);
        return firstRevision(appId, 1, written);
      }
      if (!written || written.code !== "library_conflict") return null;
    }
    return null;
  }

  function freezeCurrent(record     ) {
    const current = programCardCurrentRevision(record);
    if (revisions.load(record.appId, current)) return true;
    const written      = revisions.write(record.appId, {
      number: current,
      name: record.name,
      card: record.card,
      state: record.checkpoint.state,
      savedAtMs: record.checkpoint.savedAtMs,
      taskSlots: record.taskSlots,
    }, { ifAbsent: true, keepSeen: true });
    return written.status === "written" || written.status === "exists";
  }

  function writeLive(previous     , fields     , options      = {}) {
    const { digest: _digest, ...rest } = previous;
    return writeRecord(previous.appId, { ...rest, ...fields }, options);
  }

  function save(params      = {}, options      = {}, recovery      = null) {
    const rawName = typeof params.name === "string" ? params.name.trim() : "";
    const appIdIn = typeof params.appId === "string" ? params.appId : null;
    const reject = (code     ) => ({
      status: "rejected",
      code,
      appId: appIdIn || "",
      name: rawName,
    });
    if (params.appId !== undefined && params.appId !== null && !isValidLiveuiLibraryItemId(params.appId)) {
      return reject("app_id_invalid");
    }
    const mode = params.mode === undefined || params.mode === null ? null : params.mode;
    if (mode !== null && !PROGRAM_CARD_SAVE_MODES.includes(mode)) return reject("mode_invalid");
    if (!validProgramCardName(rawName)) return reject("name_invalid");
    if (!validProgramCardSpec(params.card)) return reject("card_invalid");
    const stateCode = stateRejection(params.state);
    if (stateCode) return reject(stateCode);
    const providedAsks = normalizeProgramCardAsks(params.asks);
    if (params.asks !== undefined && !providedAsks) return reject("asks_invalid");

    const existing      = appIdIn ? load(appIdIn) : null;
    const asks = providedAsks || normalizeProgramCardAsks(existing?.record?.asks);

    let taskSlots      = null;
    if (options.taskSlots !== undefined && options.taskSlots !== null) {
      taskSlots = normalizeTaskSlots(options.taskSlots, slotsCap());
      if (!taskSlots) return reject("task_slots_invalid");
      if (existing?.status === "accepted" && mode !== "revision" && mode !== "new") return reject("task_slots_need_revision");
    } else if (existing?.status === "accepted") {
      taskSlots = normalizeTaskSlots(existing.record.taskSlots);
    }

    const fields = {
      name: rawName,
      card: params.card,
      state: params.state,
      savedAtMs: nowMs(),
      by: normalizeProgramCardRevisionBy(params.by),

      note: normalizeProgramCardRevisionNote(recovery ? (typeof recovery.note === "string" && recovery.note.trim()
        ? recovery.note : `Recovered draft ${recovery.draftId}`) : params.note),
      description: normalizeProgramCardDescription(params.description),
      ...(asks ? { asks } : {}),
      ...(taskSlots ? { taskSlots } : {}),
    };

    if (recovery && (!existing || existing.status !== "accepted" || mode !== "revision" ||
      programCardCurrentRevision(existing.record) !== recovery.base.revision ||
      liveuiLibraryDigest(existing.record.card) !== recovery.base.sourceHash)) return reject("saved_base_conflict");
    if (!existing || existing.status !== "accepted" || mode === "new") {

      const starter = options.starter ? normalizeProgramCardRevisionStarter(options.starter) : null;
      if (options.starter && !starter) return reject("starter_invalid");

      const from = existing?.status === "accepted" && mode === "new" ? existing.record : null;
      const copied = from ? { kit: derivedKit(revisions.loadKit(appIdIn, programCardCurrentRevision(from)),
        liveuiLibraryDigest(from.card) !== liveuiLibraryDigest(fields.card)) } : {};
      return create(mode === "new" ? null : appIdIn, { ...fields, ...(starter ? { starter } : {}), ...copied }, options) || reject("save_failed");
    }

    const previous = existing.record;
    const current = programCardCurrentRevision(previous);
    let number = current;
    const pendingRevision = recovery ? revisions.list(appIdIn).find((r     ) => r.note === fields.note) : null;
    if (pendingRevision && (liveuiLibraryDigest(pendingRevision.card) !== liveuiLibraryDigest(fields.card)
      || liveuiLibraryDigest(pendingRevision.state) !== liveuiLibraryDigest(fields.state))) return reject("promotion_conflict");
    if (mode === "revision") {
      if (!freezeCurrent(previous)) return reject("save_failed");
      number = pendingRevision?.number || Math.max(current, ...revisions.numbers(appIdIn)) + 1;
      if (!validProgramCardRevisionNumber(number)) return reject("revision_limit");
    }
    const { description, asks: _asks, ...revisionFields } = fields;

    const fixed = mode === "revision" && options.fixed ? { fixed: options.fixed } : {};

    const sameCode = liveuiLibraryDigest(previous.card) === liveuiLibraryDigest(fields.card);
    const kit = derivedKit(revisions.loadKit(appIdIn, current), !sameCode, recovery?.kit);
    const revision      = pendingRevision ? { status: "written" } : revisions.write(appIdIn, { number, ...revisionFields, ...fixed }, { ifAbsent: mode === "revision" });
    if (revision.status !== "written") return reject("save_failed");
    writeKit(appIdIn, number, kit);
    const written      = writeLive(previous, {
      name: rawName,
      card: fields.card,
      checkpoint: { seq: previous.checkpoint.seq + 1, state: fields.state, savedAtMs: fields.savedAtMs },
      revision: number,
      ...(recovery ? { recoverySave: { draftId: recovery.draftId, revision: number } } : {}),
      ...(description ? { cosmetic: { ...(previous.cosmetic || {}), description } } : {}),
      ...(asks ? { asks } : {}),
      ...(taskSlots ? { taskSlots } : {}),
    }, recovery ? { expectedDigest: previous.digest } : {});
    if (!written || written.status !== "saved") return reject("save_failed");

    const dropped = mode === "revision" && options.prune !== false
      ? revisions.prune(appIdIn, number, undefined, keepRevisions(appIdIn)) : [];

    if (typeof opts.onSaved === "function") {
      try {
        opts.onSaved({ appId: appIdIn, revision: number, sourceHash: liveuiLibraryDigest(written.record.card),
          previous: { revision: current, sourceHash: liveuiLibraryDigest(previous.card) } });
      } catch (_) {  }
    }
    return {
      status: "saved",
      appId: appIdIn,
      name: rawName,
      record: written.record,
      revision: number,
      ...(dropped.length ? { dropped } : {}),
    };
  }

  function checkpoint(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const seq = Number.isSafeInteger(params.seq) ? params.seq : null;
    const reply = (status     , code      = null) => ({
      appId,
      seq: seq === null ? -1 : seq,
      status,
      ...(code ? { code } : {}),
    });
    if (seq === null || seq < 0) return reply("rejected", "seq_invalid");
    const stateCode = stateRejection(params.state);
    if (stateCode) return reply("rejected", stateCode);
    const existing      = load(appId);
    if (existing.status !== "accepted") return reply("rejected", "app_not_found");
    const record = existing.record;
    if ((params.revision !== undefined || params.sourceHash !== undefined) &&
      (params.revision !== programCardCurrentRevision(record) || params.sourceHash !== liveuiLibraryDigest(record.card)))
      return reply("rejected", "saved_base_conflict");
    if (seq <= record.checkpoint.seq) return reply("stale");
    const { digest: _digest, ...previous } = record;
    const written      = writeRecord(appId, {
      ...previous,
      checkpoint: { seq, state: params.state, savedAtMs: nowMs() },
    });
    if (!written || written.status !== "saved") return reply("rejected", "save_failed");
    return reply("saved");
  }

  function source(params      = {}) {
    const loaded      = load(params.appId);
    if (loaded.status !== "accepted") return loaded;
    const record = loaded.record;
    return {
      status: "accepted", appId: record.appId, name: record.name,
      revision: programCardCurrentRevision(record),
      sourceHash: liveuiLibraryDigest(record.card), card: record.card,

      taskSlots: normalizeTaskSlots(record.taskSlots),

      kit: revisionKit(record.appId, programCardCurrentRevision(record)),
    };
  }

  function revisionKit(appId     , number     )                           {
    try { return kitValue(revisions.loadKit(appId, number)); } catch (_) { return null; }
  }

  function open(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const requestedAtMs = Number.isSafeInteger(params.requestedAtMs) ? params.requestedAtMs : nowMs();
    const loaded      = load(appId);
    if (loaded.status !== "accepted") {
      return { status: "rejected", code: "app_not_found", appId };
    }
    const record = loaded.record;

    let kit      = null;
    try { kit = revisions.loadKit(appId, programCardCurrentRevision(record)); } catch (_) { kit = null; }
    return {
      status: "accepted",
      appId,
      open: {
        appId,
        name: record.name,
        sourceHash: liveuiLibraryDigest(record.card),
        card: record.card,
        state: record.checkpoint.state,
        seq: record.checkpoint.seq,
        savedAtMs: record.checkpoint.savedAtMs,
        requestedAtMs,
        revision: programCardCurrentRevision(record),
        ...(kit ? { kit } : {}),
      },
    };
  }

  function revisionRow(record     , current     ) {
    return {
      number: record.number,
      name: record.name,
      savedAtMs: record.savedAtMs,
      ...(record.by ? { by: record.by } : {}),
      ...(record.note ? { note: record.note } : {}),

      ...(record.fixed ? { fixed: record.fixed } : {}),

      ...(record.starter ? { starter: record.starter } : {}),

      ...(Array.isArray(record.taskSlots) && record.taskSlots.length ? { parts: record.taskSlots.length } : {}),
      current: record.number === current,
    };
  }

  function listRevisions(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const loaded      = load(appId);
    if (loaded.status !== "accepted") return { status: "rejected", code: "app_not_found", appId };
    const record = loaded.record;
    const current = programCardCurrentRevision(record);
    const rows = revisions.list(appId).map((revision     ) => revisionRow(revision, current));
    if (!rows.some((row     ) => row.current)) {
      rows.push({ number: current, name: record.name, savedAtMs: record.checkpoint.savedAtMs, current: true });
    }
    rows.sort((a     , b     ) => b.number - a.number);
    if (params.seen === false) return { status: "accepted", appId, name: record.name, current, revisions: rows };

    let pictureRoom = PROGRAM_CARD_REVISIONS_PICTURES_MAX;
    const seenRows = rows.map((row     ) => {
      const seen      = revisions.loadSeen(appId, row.number);
      if (!seen) return row;
      const { picture, ...rest } = seen;
      const fits = picture && picture.png.length <= pictureRoom;
      if (fits) pictureRoom -= picture.png.length;
      return { ...row, ...rest, ...(fits ? { picture } : {}) };
    });
    return { status: "accepted", appId, name: record.name, current, revisions: seenRows };
  }

  function noteRevisionSeen(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const loaded      = load(appId);
    if (loaded.status !== "accepted") return { status: "rejected", code: "app_not_found", appId };
    const number = params.number;
    if (!validProgramCardRevisionNumber(number) ||
      (number !== programCardCurrentRevision(loaded.record) && !revisions.load(appId, number))) {
      return { status: "rejected", code: "revision_not_found", appId };
    }
    const changed = revisions.noteSeen(appId, number, {
      picture: params.picture, tests: params.tests, testedAtMs: params.testedAtMs,
    });
    return { status: changed ? "kept" : "unchanged", appId, number };
  }

  function loadRevision(appId     , number     ) {
    const loaded      = load(appId);
    if (loaded.status !== "accepted") return { status: "rejected", code: "app_not_found", appId };
    if (!validProgramCardRevisionNumber(number)) return { status: "rejected", code: "revision_not_found", appId };
    const record = loaded.record;
    const revision = revisions.load(appId, number);
    if (revision) return { status: "accepted", record, revision };
    if (number !== programCardCurrentRevision(record)) {
      return { status: "rejected", code: "revision_not_found", appId };
    }
    return {
      status: "accepted",
      record,
      revision: {
        number,
        name: record.name,
        card: record.card,
        state: record.checkpoint.state,
        savedAtMs: record.checkpoint.savedAtMs,
      },
    };
  }

  function restoreRevision(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const number = params.number;
    const found      = loadRevision(appId, number);
    if (found.status !== "accepted") return { ...found, number };
    const record = found.record;
    if (number === programCardCurrentRevision(record)) {
      return { status: "restored", appId, number, name: record.name };
    }

    const slots = normalizeTaskSlots(found.revision.taskSlots);

    const declared = slots ? slots.map((slot     ) => slot.name) : [TASK_SLOT_FIRST];
    if (Array.isArray(params.linkedParts) && params.linkedParts.some((name     ) => !declared.includes(name)))
      return { status: "rejected", code: "card_part_linked", appId, number };
    if (!freezeCurrent(record)) return { status: "rejected", code: "save_failed", appId, number };
    const { taskSlots: _slots, ...live } = record;
    const written      = writeLive(live, { card: found.revision.card, revision: number, ...(slots ? { taskSlots: slots } : {}) });
    if (!written || written.status !== "saved") return { status: "rejected", code: "save_failed", appId, number };
    return { status: "restored", appId, number, name: record.name };
  }

  function deleteRevision(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const number = params.number;
    const loaded      = load(appId);
    if (loaded.status !== "accepted") return { status: "rejected", code: "app_not_found", appId, number };
    if (number === programCardCurrentRevision(loaded.record)) {
      return { status: "rejected", code: "revision_current", appId, number };
    }
    if (!validProgramCardRevisionNumber(number) || !revisions.remove(appId, number)) {
      return { status: "rejected", code: "revision_not_found", appId, number };
    }
    return { status: "deleted", appId, number };
  }

  function forkRevision(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const number = params.number;
    const found      = loadRevision(appId, number);
    if (found.status !== "accepted") return { ...found, number };
    const name = typeof params.name === "string" && params.name.trim() ? params.name.trim() : found.revision.name;
    if (!validProgramCardName(name)) return { status: "rejected", code: "name_invalid", appId, number };
    const created      = create(null, {
      name,
      card: found.revision.card,
      state: found.revision.state,
      savedAtMs: nowMs(),
      by: "phone",
      note: normalizeProgramCardRevisionNote(`From revision ${number} of ${found.record.name}`),
      description: found.record.cosmetic?.description || null,
      asks: found.record.asks || null,
      taskSlots: normalizeTaskSlots(found.revision.taskSlots),
      kit: revisions.loadKit(appId, number),
    }, { beforeCreate: params.beforeCreate });
    if (!created) return { status: "rejected", code: "save_failed", appId, number };
    return { status: "saved", appId: created.appId, name, revision: 1, from: { appId, number } };
  }

  function renameCard(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const name = typeof params.name === "string" ? params.name.trim() : "";
    const loaded      = load(appId);
    if (loaded.status !== "accepted") return { status: "rejected", code: "app_not_found", appId };
    if (!validProgramCardName(name)) return { status: "rejected", code: "name_invalid", appId };
    const written      = writeLive(loaded.record, { name });
    if (!written || written.status !== "saved") return { status: "rejected", code: "save_failed", appId };
    return { status: "renamed", appId, name };
  }

  function setIcon(params      = {}) {
    const appId = typeof params.appId === "string" ? params.appId : "";
    const loaded      = load(appId);
    if (loaded.status !== "accepted") return { status: "rejected", code: "app_not_found", appId };
    if (!PROGRAM_CARD_ICON_BY.includes(params.by)) return { status: "rejected", code: "icon_by_invalid", appId };
    const previous = loaded.record.cosmetic || {};
    if (previous.iconBy === "wearer" && params.by !== "wearer") return { status: "kept", appId };
    const { icon: _icon, iconBy: _iconBy, iconFor: _iconFor, ...rest } = previous;
    const cosmetic = {
      ...rest,
      ...(typeof params.icon === "string" && params.icon ? { icon: params.icon } : {}),
      iconBy: params.by,
      ...(typeof params.iconFor === "string" ? { iconFor: params.iconFor } : {}),
    };
    const written      = writeLive(loaded.record, { cosmetic });
    if (!written || written.status !== "saved") return { status: "rejected", code: "save_failed", appId };
    return { status: "saved", appId, icon: cosmetic.icon || null };
  }

  function promoteDraft(params     ) {
    if (!isValidLiveuiLibraryItemId(params.appId) || !validProgramCardName(params.name) || !validProgramCardSpec(params.card)
      || stateRejection(params.state)) return { status: "rejected", code: "invalid_request" };
    const asks = normalizeProgramCardAsks(params.asks);
    if (params.asks !== undefined && !asks) return { status: "rejected", code: "asks_invalid" };
    const existing      = load(params.appId);
    if (existing.status === "accepted") {
      if (existing.record.card?.kind !== "source" || existing.record.card.source !== params.card.source)
        return { status: "rejected", code: "promotion_conflict" };
      return { status: "saved", appId: params.appId, name: existing.record.name, revision: existing.record.revision };
    }
    return create(params.appId, { name: params.name, card: params.card, state: params.state, savedAtMs: nowMs(),
      by: normalizeProgramCardRevisionBy(params.by), note: null, description: normalizeProgramCardDescription(params.description), ...(asks ? { asks } : {}),

      ...(params.kit !== undefined ? { kit: kitValue(params.kit) } : {}) }, { ifAbsent: true })
      || { status: "rejected", code: "save_failed" };
  }

  function recoveredDraftResult(appId        , draftId        ) {
    const loaded      = load(appId);
    const receipt = loaded.status === "accepted" && loaded.record.recoverySave;
    return receipt?.draftId === draftId
      ? { status: "saved", appId, name: loaded.record.name, revision: receipt.revision }
      : null;
  }

  function promoteSavedDraft(params     , taskSlots      = null, saveOptions      = null) {
    if (!params.base || params.appId !== params.base.appId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(params.draftId))
      return { status: "rejected", code: "invalid_request" };

    const extra = saveOptions ? { ...(saveOptions.fixed ? { fixed: saveOptions.fixed } : {}),
      ...(saveOptions.prune === false ? { prune: false } : {}) } : {};

    const noted = typeof saveOptions?.note === "string" && saveOptions.note.trim() ? { ...params, note: saveOptions.note } : params;
    return recoveredDraftResult(params.appId, params.draftId) ||
      save({ ...noted, mode: "revision" }, { ...(taskSlots ? { taskSlots } : {}), ...extra }, noted);
  }

  function undoRevision(previous     , number     ) {
    if (!previous || typeof previous.appId !== "string" || !isValidLiveuiLibraryItemId(previous.appId)) return false;
    const { digest: _digest, ...rest } = previous;
    const written      = writeRecord(previous.appId, rest);
    if (!written || written.status !== "saved") return false;
    if (validProgramCardRevisionNumber(number) && number !== programCardCurrentRevision(previous)) {
      try { revisions.remove(previous.appId, number); } catch (_) {  }
    }
    return true;
  }

  function pruneRevisions(appId     ) {
    const loaded      = load(appId);
    if (loaded.status !== "accepted") return [];
    return revisions.prune(appId, programCardCurrentRevision(loaded.record), undefined, keepRevisions(appId));
  }

  function list() {
    const listed      = library.listItems();
    const items = listed?.status === "accepted" && Array.isArray(listed.items) ? listed.items : [];
    return items.filter((item     ) => item.itemType === PROGRAM_CARD_ITEM_TYPE && item.status === "ready" && typeof item.name === "string")
      .map((item     ) => ({ appId: item.itemId, name: item.name, ...(Number.isSafeInteger(item.revision) ? { revision: item.revision } : {}) }));
  }

  return {
    libraryDir: library.libraryDir,
    list,
    save,
    promoteDraft,
    promoteSavedDraft,
    recoveredDraftResult,
    undoRevision,
    pruneRevisions,
    checkpoint,
    open,
    load,
    source,
    revisionKit,
    listRevisions,

    loadRevision,
    restoreRevision,
    deleteRevision,
    forkRevision,
    renameCard,
    setIcon,
    noteRevisionSeen,

    clearRevisions: (appId     ) => revisions.clear(appId),
  };
}

const PENDING_SAVE_REQUESTS_SYMBOL = Symbol.for("ocuclaw.programCard.pendingSaveRequests");

function pendingSaveRequests(scope      = globalThis)                   {
  const host      = scope && typeof scope === "object" ? scope : globalThis;
  let map = host[PENDING_SAVE_REQUESTS_SYMBOL];
  if (!(map instanceof Map)) {
    map = new Map();
    Object.defineProperty(host, PENDING_SAVE_REQUESTS_SYMBOL, {
      value: map,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return map;
}

function awaitProgramCardSaveResult(requestId        , options      = {}) {
  const scope = options.scope || globalThis;
  const map = pendingSaveRequests(scope);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : PROGRAM_CARD_SAVE_REQUEST_TIMEOUT_MS;
  const setTimeoutFn = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const description = normalizeProgramCardDescription(options.description);
  return new Promise((resolve) => {
    const timer = setTimeoutFn(() => {
      if (map.get(requestId)?.resolve !== settle) return;
      map.delete(requestId);
      resolve({ status: "timeout", requestId });
    }, timeoutMs);
    function settle(result     ) {
      clearTimeoutFn(timer);
      resolve(result);
    }
    map.set(requestId, { resolve: settle, ...(description ? { description } : {}) });
  });
}

function programCardSaveRequestDescription(requestId     , scope      = globalThis) {
  if (typeof requestId !== "string" || !requestId) return null;
  return pendingSaveRequests(scope).get(requestId)?.description || null;
}

const CARD_DESCRIPTIONS_SYMBOL = Symbol.for("ocuclaw.programCard.descriptions");
const PROGRAM_CARD_DESCRIPTIONS_MAX = 32;
const PROGRAM_CARD_ASKS_PENDING_MS = 30_000;

const PROGRAM_CARD_READY_NOT_SHOWN = "ready_not_shown";

const PROGRAM_CARD_READY_ASKS_MS = 30 * 60_000;

function cardDescriptions(scope      = globalThis)      {
  const host      = scope && typeof scope === "object" ? scope : globalThis;
  let store = host[CARD_DESCRIPTIONS_SYMBOL];
  if (!store || !(store.bySource instanceof Map) || !(store.openBySession instanceof Map)) {
    store = { bySource: new Map(), openBySession: new Map() };
    Object.defineProperty(host, CARD_DESCRIPTIONS_SYMBOL, {
      value: store,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  if (!(store.pendingAsks instanceof Map)) store.pendingAsks = new Map();
  if (!(store.planIconBySession instanceof Map)) store.planIconBySession = new Map();
  if (!(store.planIconBySource instanceof Map)) store.planIconBySource = new Map();
  for (const [requestId, request] of store.pendingAsks) {
    if (!Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now()) store.pendingAsks.delete(requestId);
  }
  return store;
}

function keepNewest(map                  , key        , value     ) {
  map.delete(key);
  map.set(key, value);
  while (map.size > PROGRAM_CARD_DESCRIPTIONS_MAX) map.delete(map.keys().next().value          );
}

function rememberProgramCardDescription(source     , description     , scope      = globalThis) {
  const line = normalizeProgramCardDescription(description);
  if (typeof source !== "string" || !source || !line) return false;
  keepNewest(cardDescriptions(scope).bySource, source, line);
  return true;
}

function programCardDescriptionForSource(source     , scope      = globalThis) {
  if (typeof source !== "string" || !source) return null;
  return cardDescriptions(scope).bySource.get(source) || null;
}

function planIconSessionKey(sessionKey     ) {
  return typeof sessionKey === "string" && sessionKey ? relaySessionKeyFor(sessionKey) || sessionKey : null;
}

function notePlanIcon(sessionKey     , pick     , scope      = globalThis) {
  const key = planIconSessionKey(sessionKey);
  if (!key) return false;
  const store = cardDescriptions(scope);
  if (!pick || typeof pick !== "object") return store.planIconBySession.delete(key);
  keepNewest(store.planIconBySession, key, pick);
  return true;
}

function planIconForSession(sessionKey     , scope      = globalThis) {
  const key = planIconSessionKey(sessionKey);
  return key ? cardDescriptions(scope).planIconBySession.get(key) || null : null;
}

function linkPlanIconToSource(sessionKey     , source     , scope      = globalThis) {
  const pick = planIconForSession(sessionKey, scope);
  if (!pick || typeof source !== "string" || !source) return false;
  keepNewest(cardDescriptions(scope).planIconBySource, source, pick);
  return true;
}

function planIconForSource(source     , scope      = globalThis) {
  if (typeof source !== "string" || !source) return null;
  return cardDescriptions(scope).planIconBySource.get(source) || null;
}

function forgetPlanIconForSource(source     , scope      = globalThis) {
  if (typeof source !== "string" || !source) return false;
  return cardDescriptions(scope).planIconBySource.delete(source);
}

function cardWriteRequestId(value     ) {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !/\s/.test(value) ? value : null;
}

function asksOwnerKey(sessionKey        , card     ) {
  return JSON.stringify([sessionKey, card.cardId, card.writeRequestId, card.clientId]);
}

function keepCardAsks(store     , sessionKey        , card     , asks     , draftId      = card.asksDraftId) {
  const checked = normalizeProgramCardAsks(asks);
  if (!checked || !card.writeRequestId || !card.clientId || store.openBySession.get(sessionKey) !== card) return false;
  card.asks = checked;
  card.asksDraftId = typeof draftId === "string" && draftId ? draftId : null;
  return true;
}

function beginProgramCardAsks(requestId     , sessionKey     , source     , asks     , scope      = globalThis, draftId      = null) {
  if (!cardWriteRequestId(requestId) || typeof sessionKey !== "string" || !sessionKey || typeof source !== "string" || !source) return null;
  sessionKey = relaySessionKeyFor(sessionKey) || sessionKey;
  const store = cardDescriptions(scope);

  for (const [id, request] of store.pendingAsks) {
    if (request.sessionKey === sessionKey) store.pendingAsks.delete(id);
  }
  const checked = normalizeProgramCardAsks(asks);
  keepNewest(store.pendingAsks, requestId,
    { sessionKey, source, asks: checked, draftId, accepted: false, cardId: null, clientId: null, closedClients: new Set        (),
      expiresAt: Date.now() + PROGRAM_CARD_ASKS_PENDING_MS });
  return requestId;
}

function finishProgramCardAsks(requestId     , accepted         , clientId     , sessionKey     , scope      = globalThis, keepMs = 0) {
  const store = cardDescriptions(scope), pending = store.pendingAsks.get(requestId);
  if (!pending) return false;
  const session = typeof sessionKey === "string" ? relaySessionKeyFor(sessionKey) || sessionKey : null;
  if (!accepted || typeof clientId !== "string" || !clientId || session !== pending.sessionKey) {
    store.pendingAsks.delete(requestId);
    return false;
  }
  const card = store.openBySession.get(pending.sessionKey);
  if (card?.clientId === clientId && card.writeRequestId !== requestId) delete card.asks;
  if (pending.closedClients.has(clientId) || (pending.cardId && pending.clientId !== clientId)) {
    store.pendingAsks.delete(requestId);
    return false;
  }
  pending.accepted = true;
  pending.clientId = clientId;
  if (Number.isFinite(keepMs) && keepMs > 0) pending.expiresAt = Math.max(pending.expiresAt, Date.now() + keepMs);
  if (!card || card.writeRequestId !== requestId || (pending.cardId && card.cardId !== pending.cardId) ||
    card.source !== pending.source || card.clientId !== clientId) return false;
  store.pendingAsks.delete(requestId);
  return keepCardAsks(store, pending.sessionKey, card, pending.asks, pending.draftId);
}

function programCardAsksForSave(clientId     , sessionKey     , source     , scope      = globalThis, draftId      = null) {
  if (typeof clientId !== "string" || !clientId || typeof source !== "string" || !source) return null;
  const selected = typeof sessionKey === "string" && sessionKey ? relaySessionKeyFor(sessionKey) || sessionKey : null;
  const store = cardDescriptions(scope);
  const owners = [...store.openBySession.entries()].filter(([key, card]     ) =>
    card.clientId === clientId && card.source === source && (!selected || key === selected));
  if (owners.length !== 1) return null;
  const [key, card]      = owners[0];
  if (draftId !== null && card.asksDraftId !== draftId) return null;
  for (const [id, request] of store.pendingAsks) {
    if (request.sessionKey === key && id !== card.writeRequestId) return null;
  }
  return normalizeProgramCardAsks(card.asks);
}

function rememberOpenProgramCardAsks(sessionKey        , cardId        , asks     , scope      = globalThis, onlyIfMissing = false) {
  const store = cardDescriptions(scope);
  const card = store.openBySession.get(relaySessionKeyFor(sessionKey) || sessionKey);
  if (!card || card.cardId !== cardId) return false;
  const key = relaySessionKeyFor(sessionKey) || sessionKey;
  const previous = card.asks;
  if (onlyIfMissing && previous?.requirements?.length) return false;
  return keepCardAsks(store, key, card, { ...(previous || {}), ...asks });
}

function noteOpenProgramCard(sessionKey     , cardId     , source     , scope      = globalThis, clientId      = null, writeRequestId      = null) {
  if (typeof sessionKey !== "string" || !sessionKey) return;
  sessionKey = relaySessionKeyFor(sessionKey) || sessionKey;
  const store = cardDescriptions(scope);
  if (typeof cardId !== "string" || !cardId || typeof source !== "string" || !source) {
    const closedId = cardWriteRequestId(writeRequestId);
    const current = store.openBySession.get(sessionKey);
    if (current && current.writeRequestId === closedId && current.clientId === clientId) store.openBySession.delete(sessionKey);
    for (const [id, request] of store.pendingAsks) {
      if (request.sessionKey !== sessionKey || id !== closedId || typeof clientId !== "string" || !clientId) continue;
      if (request.clientId === clientId) store.pendingAsks.delete(id);
      else if (!request.clientId) {
        request.closedClients.add(clientId);
        if (request.closedClients.size > PROGRAM_CARD_DESCRIPTIONS_MAX) store.pendingAsks.delete(id);
      }
    }
    return;
  }
  const card      = { cardId, source, clientId: typeof clientId === "string" && clientId ? clientId : null,
    writeRequestId: cardWriteRequestId(writeRequestId) };
  const previous = store.openBySession.get(sessionKey);
  if (previous && previous.cardId === cardId && previous.source !== source && !store.bySource.has(source)) {
    const description = store.bySource.get(previous.source);
    if (description) keepNewest(store.bySource, source, description);
  }

  if (previous && previous.cardId === cardId && previous.source !== source && !store.planIconBySource.has(source)) {
    const pick = store.planIconBySource.get(previous.source);
    if (pick) keepNewest(store.planIconBySource, source, pick);
  }
  const ownerKey = asksOwnerKey(sessionKey, card);

  if (previous && asksOwnerKey(sessionKey, previous) === ownerKey && previous.asks) {
    card.asks = previous.asks;
    card.asksDraftId = previous.asksDraftId;
  }
  keepNewest(store.openBySession, sessionKey, card);
  for (const [id, request] of store.pendingAsks) {
    if (request.sessionKey !== sessionKey) continue;
    if ((request.accepted || request.cardId) && (id !== card.writeRequestId || request.source !== source ||
      (request.cardId && request.cardId !== cardId) || (request.clientId && request.clientId !== card.clientId))) {
      store.pendingAsks.delete(id);
    }
  }
  const requestId = card.writeRequestId;
  const request = requestId ? store.pendingAsks.get(requestId) : null;
  if (request && request.sessionKey === sessionKey && request.source === source &&
    !request.closedClients.has(card.clientId) && (!request.clientId || request.clientId === card.clientId)) {
    request.cardId = cardId;
    request.clientId = card.clientId;
    if (request.accepted) {
      store.pendingAsks.delete(requestId);
      keepCardAsks(store, sessionKey, card, request.asks, request.draftId);
    }
  }
}

function forgetProgramCardClient(clientId     , scope      = globalThis) {
  const store = cardDescriptions(scope), sessions = new Set        ();
  for (const [sessionKey, card] of store.openBySession) {
    if (card.clientId === clientId) { store.openBySession.delete(sessionKey); sessions.add(sessionKey); }
  }
  for (const [requestId, request] of store.pendingAsks) {
    if (request.clientId === clientId || sessions.has(request.sessionKey)) store.pendingAsks.delete(requestId);
  }
}

function resolveProgramCardSaveRequest(requestId     , result     , scope      = globalThis) {
  if (typeof requestId !== "string" || !requestId) return false;
  const map = pendingSaveRequests(scope);
  const pending = map.get(requestId);
  if (!pending) return false;
  map.delete(requestId);
  pending.resolve(result);
  return true;
}

module.exports = { PROGRAM_CARD_ITEM_TYPE, PROGRAM_CARD_SAVE_MODES, PROGRAM_CARD_REQUEST_ID_MAX, PROGRAM_CARD_ERROR_CODE_MAX, PROGRAM_CARD_SLUG_MAX, PROGRAM_CARD_SAVE_REQUEST_TIMEOUT_MS, PROGRAM_CARD_REVISIONS_PICTURES_MAX, programCardSlug, normalizeProgramCardErrorCode, createProgramCardSaves, awaitProgramCardSaveResult, programCardSaveRequestDescription, PROGRAM_CARD_DESCRIPTIONS_MAX, PROGRAM_CARD_READY_NOT_SHOWN, PROGRAM_CARD_READY_ASKS_MS, rememberProgramCardDescription, programCardDescriptionForSource, notePlanIcon, planIconForSession, linkPlanIconToSource, planIconForSource, forgetPlanIconForSource, beginProgramCardAsks, finishProgramCardAsks, programCardAsksForSave, rememberOpenProgramCardAsks, noteOpenProgramCard, forgetProgramCardClient, resolveProgramCardSaveRequest };
