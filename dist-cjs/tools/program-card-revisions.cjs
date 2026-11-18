const nodeFs = require("node:fs");

const path = require("node:path");
const { PROGRAM_CARD_REVISIONS_DIRECTORY, PROGRAM_CARD_STATE_MAX_BYTES, atomicWriteLiveuiLibraryRecord, canonicalSerialize, isValidLiveuiLibraryItemId, liveuiLibraryDigest, programCardStateBytes, programCardStateDepthOk, resolveLiveuiLibraryRoot, validProgramCardName, validProgramCardRevisionNumber, validProgramCardSpec } = require("./glasses-ui-library.cjs");
const { normalizeTaskSlots } = require("./glasses-ui-task-slots.cjs");
const { programCardKitLevelValue } = require("./program-card-kit-check.cjs");
const { carryUnknownFields, hasUnknownFields, knownFields } = require("./saved-format.cjs");

const PROGRAM_CARD_REVISIONS_MAX = 20;
const PROGRAM_CARD_REVISION_NOTE_MAX = 200;

const PROGRAM_CARD_REVISION_BY = Object.freeze(["glasses", "agent", "phone"]);

const REVISION_SCHEMA_VERSION = 1;
const REVISION_FILE_RE = /^r([1-9][0-9]{0,5})\.json$/;

const SEEN_SCHEMA_VERSION = 1;

const PROGRAM_CARD_REVISION_PICTURE_MAX = 96 * 1024;

const SEEN_TESTS_MAX = 6;
const SEEN_REQUIREMENT_MAX = 80;

const PROGRAM_CARD_ASK_VERDICTS = Object.freeze(["passed", "fixed", "still_open", "wearer_check", "not_tested"]);
const PNG_BASE64_RE = /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/;
const REVISION_KEYS = new Set([
  "schemaVersion",
  "appId",
  "number",
  "name",
  "card",
  "state",
  "savedAtMs",
  "by",
  "note",
  "taskSlots",
  "fixed",
  "starter",
  "digest",
]);

const PROGRAM_CARD_REVISION_SAVED_SHAPE             = Object.freeze({
  fields: [...REVISION_KEYS],
  parts: {
    card: { fields: ["kind", "id", "source"], replaced: true },
    fixed: { fields: ["task", "key", "label", "change"] },
    starter: { fields: ["id", "version"] },
  },
  lists: { taskSlots: { by: "name", fields: ["name", "label", "inputs", "maxBytes"] } },
});

const PROGRAM_CARD_SEEN_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "appId", "number", "picture", "tests", "testedAtMs", "kit"],
  parts: { picture: { fields: ["png"] }, kit: { fields: ["level"] } },
});

function hasOnlyKeys(value     , allowed     ) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeProgramCardRevisionNote(note     ) {
  if (typeof note !== "string") return null;
  const text = note.replace(/\s+/g, " ").trim().slice(0, PROGRAM_CARD_REVISION_NOTE_MAX).trim();
  return text || null;
}

const FIXED_CHANGES = new Set(["number_to_text", "fields_to_text", "list_to_text"]);
const FIXED_TEXT_MAX = 120;
const FIXED_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

function normalizeProgramCardRevisionFixed(fixed     ) {
  if (!fixed || typeof fixed !== "object" || Array.isArray(fixed)) return null;
  const text = (value     ) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, FIXED_TEXT_MAX).trim() : "";
  const task = text(fixed.task);
  const label = text(fixed.label);
  if (!task || typeof fixed.key !== "string" || !FIXED_KEY_RE.test(fixed.key) || !FIXED_CHANGES.has(fixed.change)) return null;
  return { task, key: fixed.key, ...(label ? { label } : {}), change: fixed.change };
}

const STARTER_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

function normalizeProgramCardRevisionStarter(starter     ) {
  if (!starter || typeof starter !== "object" || Array.isArray(starter)) return null;
  if (typeof starter.id !== "string" || !STARTER_ID_RE.test(starter.id)) return null;
  if (!Number.isSafeInteger(starter.version) || starter.version < 1) return null;
  return { id: starter.id, version: starter.version };
}

function sameFixed(a     , b     ) {
  const normal = normalizeProgramCardRevisionFixed(b);
  return !!normal && Object.keys(a).length === Object.keys(normal).length &&
    Object.entries(normal).every(([key, value]) => a[key] === value);
}

function normalizeProgramCardRevisionBy(by     ) {
  return PROGRAM_CARD_REVISION_BY.includes(by) ? by : null;
}

function validRevisionRecord(record     , appId     , number     , digestHeld = false) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (!hasOnlyKeys(record, REVISION_KEYS)) return false;
  if (record.schemaVersion !== REVISION_SCHEMA_VERSION) return false;
  if (record.appId !== appId || record.number !== number) return false;
  if (!validProgramCardName(record.name) || !validProgramCardSpec(record.card)) return false;
  const stateBytes = programCardStateBytes(record.state);
  if (stateBytes < 0 || stateBytes > PROGRAM_CARD_STATE_MAX_BYTES) return false;
  if (!Number.isSafeInteger(record.savedAtMs)) return false;
  if (record.by !== undefined && normalizeProgramCardRevisionBy(record.by) === null) return false;
  if (record.note !== undefined && normalizeProgramCardRevisionNote(record.note) !== record.note) return false;

  if (record.taskSlots !== undefined && !normalizeTaskSlots(record.taskSlots)) return false;

  if (record.fixed !== undefined && !sameFixed(record.fixed, record.fixed)) return false;

  if (record.starter !== undefined) {
    const starter = normalizeProgramCardRevisionStarter(record.starter);
    if (!starter || Object.keys(record.starter).length !== 2 || record.starter.id !== starter.id ||
      record.starter.version !== starter.version) return false;
  }
  if (typeof record.digest !== "string" || !record.digest) return false;
  if (digestHeld) return true;
  const { digest, ...digestInput } = record;
  return digest === liveuiLibraryDigest(digestInput);
}

function programCardRevisionPicture(png     ) {
  return typeof png === "string" && png.length <= PROGRAM_CARD_REVISION_PICTURE_MAX && PNG_BASE64_RE.test(png) ? png : null;
}

function normalizeProgramCardAskVerdicts(tests     ) {
  if (!Array.isArray(tests)) return null;
  const out        = [];
  for (const test of tests) {
    const requirement = typeof test?.requirement === "string" ? test.requirement.trim() : "";
    if (!requirement || requirement.length > SEEN_REQUIREMENT_MAX || !PROGRAM_CARD_ASK_VERDICTS.includes(test.verdict) ||
      out.some((kept) => kept.requirement === requirement)) continue;
    out.push({ requirement, verdict: test.verdict });
    if (out.length === SEEN_TESTS_MAX) break;
  }
  return out.length ? out : null;
}

function validSeenRecord(record     , appId     , number     ) {
  return !!record && typeof record === "object" && !Array.isArray(record) &&
    record.schemaVersion === SEEN_SCHEMA_VERSION && record.appId === appId && record.number === number;
}

function createProgramCardRevisions(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const root = path.join(libraryDir, PROGRAM_CARD_REVISIONS_DIRECTORY);

  function cardDir(appId     ) {
    return isValidLiveuiLibraryItemId(appId) ? path.join(root, appId) : null;
  }

  function revisionPath(appId     , number     ) {
    const directory = cardDir(appId);
    return directory && validProgramCardRevisionNumber(number)
      ? path.join(directory, `r${number}.json`)
      : null;
  }

  function seenPath(appId     , number     ) {
    const directory = cardDir(appId);
    return directory && validProgramCardRevisionNumber(number)
      ? path.join(directory, `r${number}.seen.json`)
      : null;
  }

  function keptSeen(target     , record     , appId     , number     ) {
    let before;
    try {
      before = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (_) {
      return record;
    }
    return validSeenRecord(before, appId, number) && hasUnknownFields(before, PROGRAM_CARD_SEEN_SAVED_SHAPE)
      ? carryUnknownFields(before, record, PROGRAM_CARD_SEEN_SAVED_SHAPE)
      : record;
  }

  function removeSeen(appId     , number     ) {
    const target = seenPath(appId, number);
    if (!target) return;
    try {
      fs.unlinkSync(target);
    } catch (err     ) {
      if (!err || err.code !== "ENOENT") throw err;
    }
  }

  function loadSeen(appId     , number     ) {
    const target = seenPath(appId, number);
    if (!target) return null;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (_) {
      return null;
    }
    if (!validSeenRecord(record, appId, number)) return null;
    const picture = programCardRevisionPicture(record.picture?.png);
    const tests = normalizeProgramCardAskVerdicts(record.tests);
    return {
      ...(picture ? { picture: { png: picture } } : {}),
      ...(tests ? { tests, ...(Number.isSafeInteger(record.testedAtMs) ? { testedAtMs: record.testedAtMs } : {}) } : {}),
    };
  }

  function noteSeen(appId     , number     , seen      = {}) {
    const target = seenPath(appId, number);
    if (!target) return false;
    const before      = loadSeen(appId, number) || {};
    const picture = before.picture ? null : programCardRevisionPicture(seen.picture);
    const tests = normalizeProgramCardAskVerdicts(seen.tests);
    if (!picture && !tests) return false;
    const kit = loadKit(appId, number);
    const record = {
      schemaVersion: SEEN_SCHEMA_VERSION,
      appId,
      number,
      ...(before.picture || picture ? { picture: before.picture || { png: picture } } : {}),
      ...(tests ? { tests, testedAtMs: Number.isSafeInteger(seen.testedAtMs) ? seen.testedAtMs : Date.now() }
        : before.tests ? { tests: before.tests, ...(before.testedAtMs !== undefined ? { testedAtMs: before.testedAtMs } : {}) } : {}),

      ...(kit ? { kit } : {}),
    };
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: target, record: keptSeen(target, record, appId, number) });
    return true;
  }

  function loadKit(appId     , number     ) {
    const target = seenPath(appId, number);
    if (!target) return null;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (_) {
      return null;
    }
    if (!validSeenRecord(record, appId, number)) return null;
    const level = programCardKitLevelValue(record.kit?.level);
    return level === null ? null : { level };
  }

  function noteKit(appId     , number     , level     ) {
    const target = seenPath(appId, number);
    const stamp = programCardKitLevelValue(level);
    if (!target || stamp === null) return false;
    if (loadKit(appId, number)?.level === stamp) return false;
    const before      = loadSeen(appId, number) || {};
    const record = {
      schemaVersion: SEEN_SCHEMA_VERSION,
      appId,
      number,
      ...(before.picture ? { picture: before.picture } : {}),
      ...(before.tests ? { tests: before.tests, ...(before.testedAtMs !== undefined ? { testedAtMs: before.testedAtMs } : {}) } : {}),
      kit: { level: stamp },
    };
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: target, record: keptSeen(target, record, appId, number) });
    return true;
  }

  function numbers(appId     ) {
    const directory = cardDir(appId);
    if (!directory) return [];
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (err     ) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
    const found           = [];
    for (const name of names) {
      const match = typeof name === "string" ? REVISION_FILE_RE.exec(name) : null;
      if (match) found.push(Number(match[1]));
    }
    return found.sort((a, b) => a - b);
  }

  function load(appId     , number     ) {
    const target = revisionPath(appId, number);
    if (!target) return null;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (_) {
      return null;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;

    const { digest, ...whole } = record;
    if (typeof digest !== "string" || digest !== liveuiLibraryDigest(whole)) return null;
    const known = knownFields(record, PROGRAM_CARD_REVISION_SAVED_SHAPE);
    return validRevisionRecord(known, appId, number, true) ? known : null;
  }

  function keptRevision(target     , digestInput     , appId     , number     ) {
    let before;
    try {
      before = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (_) {
      return null;
    }
    if (!before || typeof before !== "object" || Array.isArray(before)) return null;
    const { digest, ...whole } = before;
    if (typeof digest !== "string" || digest !== liveuiLibraryDigest(whole)) return null;
    if (!hasUnknownFields(whole, PROGRAM_CARD_REVISION_SAVED_SHAPE)) return null;
    if (!validRevisionRecord(knownFields(before, PROGRAM_CARD_REVISION_SAVED_SHAPE), appId, number, true)) return null;
    const carried = carryUnknownFields(whole, digestInput, PROGRAM_CARD_REVISION_SAVED_SHAPE);
    return JSON.parse(canonicalSerialize({ ...carried, digest: liveuiLibraryDigest(carried) }));
  }

  function list(appId     ) {
    const records        = [];
    for (const number of numbers(appId)) {
      const record = load(appId, number);
      if (record) records.push(record);
    }
    return records;
  }

  function write(appId     , input      = {}, options      = {}) {
    const target = revisionPath(appId, input.number);
    if (!target) return { status: "rejected", code: "revision_invalid" };

    if (!programCardStateDepthOk(input.state)) return { status: "rejected", code: "state_invalid" };
    const by = normalizeProgramCardRevisionBy(input.by);
    const note = normalizeProgramCardRevisionNote(input.note);
    const taskSlots = input.taskSlots === undefined || input.taskSlots === null ? null : normalizeTaskSlots(input.taskSlots);
    if (input.taskSlots !== undefined && input.taskSlots !== null && !taskSlots) return { status: "rejected", code: "revision_invalid" };
    const fixed = input.fixed === undefined || input.fixed === null ? null : normalizeProgramCardRevisionFixed(input.fixed);
    if (input.fixed !== undefined && input.fixed !== null && !fixed) return { status: "rejected", code: "revision_invalid" };
    const starter = input.starter === undefined || input.starter === null ? null : normalizeProgramCardRevisionStarter(input.starter);
    if (input.starter !== undefined && input.starter !== null && !starter) return { status: "rejected", code: "revision_invalid" };
    const digestInput = {
      schemaVersion: REVISION_SCHEMA_VERSION,
      appId,
      number: input.number,
      name: input.name,
      card: input.card,
      state: input.state,
      savedAtMs: input.savedAtMs,
      ...(by ? { by } : {}),
      ...(note ? { note } : {}),
      ...(taskSlots ? { taskSlots } : {}),
      ...(fixed ? { fixed } : {}),
      ...(starter ? { starter } : {}),
    };
    const record = JSON.parse(
      canonicalSerialize({ ...digestInput, digest: liveuiLibraryDigest(digestInput) }),
    );
    if (!validRevisionRecord(record, appId, input.number)) {
      return { status: "rejected", code: "revision_invalid" };
    }

    const kept = options.ifAbsent === true ? null : keptRevision(target, digestInput, appId, input.number);
    const written      = atomicWriteLiveuiLibraryRecord({
      fs,
      libraryDir,
      targetPath: target,
      record: kept || record,
      ifAbsent: options.ifAbsent === true,
    });
    if (written.status === "exists") return { status: "exists" };

    if (options.keepSeen !== true) removeSeen(appId, input.number);
    return { status: "written", record: kept ? knownFields(kept, PROGRAM_CARD_REVISION_SAVED_SHAPE) : record };
  }

  function remove(appId     , number     ) {
    const target = revisionPath(appId, number);
    if (!target) return false;
    removeSeen(appId, number);
    try {
      fs.unlinkSync(target);
      return true;
    } catch (err     ) {
      if (err && err.code === "ENOENT") return false;
      throw err;
    }
  }

  function clear(appId     ) {
    const directory = cardDir(appId);
    if (!directory) return;
    fs.rmSync(directory, { recursive: true, force: true });
  }

  function prune(appId     , current     , max      = PROGRAM_CARD_REVISIONS_MAX, keep           = []) {
    const all = numbers(appId);
    const dropped           = [];
    let count = all.length;
    for (const number of all) {
      if (count <= max) break;
      if (number === current || keep.includes(number)) continue;
      if (remove(appId, number)) {
        dropped.push(number);
        count -= 1;
      }
    }
    return dropped;
  }

  return { root, numbers, load, list, write, remove, clear, prune, loadSeen, noteSeen, loadKit, noteKit };
}

module.exports = { PROGRAM_CARD_REVISIONS_DIRECTORY, PROGRAM_CARD_REVISIONS_MAX, PROGRAM_CARD_REVISION_NOTE_MAX, PROGRAM_CARD_REVISION_BY, PROGRAM_CARD_REVISION_PICTURE_MAX, PROGRAM_CARD_ASK_VERDICTS, PROGRAM_CARD_REVISION_SAVED_SHAPE, PROGRAM_CARD_SEEN_SAVED_SHAPE, normalizeProgramCardRevisionNote, normalizeProgramCardRevisionFixed, normalizeProgramCardRevisionStarter, normalizeProgramCardRevisionBy, programCardRevisionPicture, normalizeProgramCardAskVerdicts, createProgramCardRevisions };
