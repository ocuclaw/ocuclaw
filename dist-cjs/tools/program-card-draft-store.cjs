const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { createHash, randomUUID } = require("node:crypto");
const { Buffer } = require("node:buffer");
const { PROGRAM_CARD_SOURCE_MAX, PROGRAM_CARD_STATE_MAX_BYTES } = require("./glasses-ui-library.cjs");
const { programCardKitLevelValue } = require("./program-card-kit-check.cjs");
const { carryUnknownFields } = require("./saved-format.cjs");

const PROGRAM_CARD_DRAFT_SAVED_SHAPE             = Object.freeze({
  fields: ["version", "draftId", "ownerHash", "revision", "checkpointSeq", "createdAt", "updatedAt", "title", "source",
    "state", "promotion", "base", "kit"],

  parts: { kit: { replaced: true, fields: ["level"] } },
});
const PROGRAM_CARD_DRAFT_LIST_SAVED_SHAPE             = Object.freeze({
  fields: ["version", "ownerHash", "ids"],
});
const MAX_LIST_BYTES = 4096;

class ProgramCardDraftError extends Error {
  code        ;
  draftId         ;
  constructor(code        , draftId         ) {
    super(code); this.name = "ProgramCardDraftError"; this.code = code; this.draftId = draftId;
  }
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 512 * 1024;
function validBase(base                      )          {
  return !!base && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(base.appId)
    && Number.isSafeInteger(base.revision) && base.revision > 0
    && /^sha256:[0-9a-f]{64}$/.test(base.sourceHash);
}
const PROGRAM_CARD_DRAFT_LIMIT = 10;

const PROGRAM_CARD_DRAFT_READ_STATE_BYTES = 65536;
function jsonSnapshot(value                          , maxStateBytes         = PROGRAM_CARD_STATE_MAX_BYTES)                           {
  if (!value || typeof value.title !== "string" || value.title.length < 1 || value.title.length > 256
    || typeof value.source !== "string" || !value.source.trim() || value.source.length > PROGRAM_CARD_SOURCE_MAX) {
    throw new ProgramCardDraftError("invalid_snapshot");
  }

  let state                    ;
  try { state = JSON.stringify(value.state); } catch { throw new ProgramCardDraftError("invalid_state"); }
  if (state === undefined || Buffer.byteLength(state, "utf8") > maxStateBytes) throw new ProgramCardDraftError("invalid_state");
  return { title: value.title, source: value.source, state: JSON.parse(state) };
}
function validVersion(value                         )          {
  return !!value && Number.isSafeInteger(value.revision) && value.revision > 0
    && Number.isSafeInteger(value.checkpointSeq) && value.checkpointSeq >= 0;
}
const privateMode = (s     , directory         ) => {
  if (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) return false;
  return process.platform === "win32" || ((s.mode & 0o077) === 0 && (typeof process.getuid !== "function" || s.uid === process.getuid()));
};

function processBirth(pid        )         {

  if (process.platform !== "linux") return "";
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] || "";
  } catch { return ""; }
}

function ownerAlive(pid        , birth        )          {
  try { process.kill(pid, 0); }
  catch (error     ) { return error?.code !== "ESRCH"; }
  const current = processBirth(pid);
  return !(birth && current && birth !== current);
}

function createProgramCardDraftStore(stateDir        , owner                       ,
  opts                               = {}) {
  if (!path.isAbsolute(stateDir)) throw new ProgramCardDraftError("unavailable");

  const kitStamp = ()                              => {
    let level                = null;
    try { level = programCardKitLevelValue(opts.kitLevel?.()); } catch { level = null; }
    return level === null ? {} : { kit: { level } };
  };

  const derivedStamp = (from                                      , changed         )                              => {
    const kept = programCardKitLevelValue(from?.level);
    if (!changed) return kept === null ? {} : { kit: { level: kept } };
    const now = kitStamp().kit?.level ?? null;
    if (kept === null) return now === null ? {} : { kit: { level: now } };
    return { kit: { level: now === null ? kept : Math.max(kept, now) } };
  };
  const keys =[owner?.installation, owner?.backend, owner?.profile, owner?.agent, owner?.conversation];
  if (keys.some(v => typeof v !== "string" || !v.trim() || v.length > 4096)
    || !["openclaw", "hermes"].includes(owner.backend)) throw new ProgramCardDraftError("invalid_owner");
  const ownerHash = createHash("sha256").update(JSON.stringify(keys)).digest("hex");
  const root = path.join(stateDir, "program-card-drafts-v1");
  const directory = path.join(root, ownerHash);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  function checkDirectory(create = false)          {
    try {
      for (const dir of [root, directory]) {
        if (create) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e     ) { if (e?.code !== "EEXIST") throw e; } }
        if (!privateMode(fs.lstatSync(dir), true)) throw new ProgramCardDraftError("unavailable");
      }
      return true;
    } catch (e     ) {
      if (!create && e?.code === "ENOENT") return false;
      throw new ProgramCardDraftError("unavailable");
    }
  }
  function filename(draftId        )         {
    if (typeof draftId !== "string" || !ID.test(draftId)) throw new ProgramCardDraftError("invalid_id");
    return path.join(directory, draftId + ".json");
  }

  function readFile(draftId        )                                                        {
    const file = filename(draftId);
    if (!checkDirectory()) return null;
    let fd                    ;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(fd);
      if (!privateMode(stat, false) || stat.size > MAX_RECORD_BYTES) throw new Error();
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (value.version !== 1 || value.ownerHash !== ownerHash || value.draftId !== draftId
        || !validVersion(value) || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") throw new Error();
      const snapshot = jsonSnapshot(value, PROGRAM_CARD_DRAFT_READ_STATE_BYTES);
      const promotion = value.promotion;
      if (value.base && !validBase(value.base)) throw new Error();
      if (promotion && ((promotion.appId !== `draft-${draftId}` && promotion.appId !== value.base?.appId) || !["pending", "saved"].includes(promotion.status))) throw new Error();
      return { whole: value, record: { version: 1, draftId, ownerHash, revision: value.revision, checkpointSeq: value.checkpointSeq,
        createdAt: value.createdAt, updatedAt: value.updatedAt, ...snapshot, ...(promotion ? { promotion } : {}), ...(value.base ? { base: value.base } : {}),

        ...(programCardKitLevelValue(value.kit?.level) !== null ? { kit: { level: value.kit.level } } : {}) } };
    } catch (e     ) {
      if (e?.code === "ENOENT") return null;
      throw new ProgramCardDraftError("unavailable");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function readRaw(draftId        )                                {
    return readFile(draftId)?.record ?? null;
  }
  const collectionFile = path.join(directory, "collection.json");
  function readCollection()                         {
    let fd                    ;
    try {
      fd = fs.openSync(collectionFile, fs.constants.O_RDONLY | noFollow);
      const stat = fs.fstatSync(fd);
      if (!privateMode(stat, false) || stat.size > MAX_LIST_BYTES) throw new Error();
      const value = JSON.parse(fs.readFileSync(fd, "utf8"));
      if (value.version !== 1 || value.ownerHash !== ownerHash || !Array.isArray(value.ids)
        || value.ids.length > PROGRAM_CARD_DRAFT_LIMIT || new Set(value.ids).size !== value.ids.length
        || value.ids.some((id     ) => typeof id !== "string" || !ID.test(id))) throw new Error();
      return value;
    } catch (e     ) {
      if (e?.code === "ENOENT") return null;
      throw new ProgramCardDraftError("unavailable");
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  function rawRecords()                           {
    return fs.readdirSync(directory).filter((name        ) => name.endsWith(".json") && ID.test(name.slice(0, -5)))
      .map((name        ) => readRaw(name.slice(0, -5))).filter((value                               ) => value !== null);
  }
  function collection()                  {
    return readCollection() || transaction("", () => readCollection() );
  }
  function read(draftId        )                                {
    filename(draftId);
    if (!checkDirectory()) return null;
    const ids = collection().ids;
    const record = readRaw(draftId);
    return record && (record.promotion?.status === "saved" || ids.includes(draftId)) ? record : null;
  }
  function commitCollection(ids          , draftId        ) {
    const list = { version: 1, ownerHash, ids };

    let before      = null;
    try { before = readCollection(); } catch { before = null; }
    const carried = before ? carryUnknownFields(before, list, PROGRAM_CARD_DRAFT_LIST_SAVED_SHAPE) : list;
    commitBytes(collectionFile, Buffer.byteLength(JSON.stringify(carried), "utf8") <= MAX_LIST_BYTES ? carried : list, draftId);
  }
  function cleanUnlisted() {

    const ids = readCollection()?.ids;
    if (!ids) return;
    for (const record of rawRecords()) {
      if (!ids.includes(record.draftId) && record.promotion?.status !== "saved") fs.unlinkSync(filename(record.draftId));
    }
    syncDirectory();
  }
  function claimWriter()             {
    const claims = path.join(directory, ".write-locks");
    fs.mkdirSync(claims, { mode: 0o700, recursive: true });
    if (!privateMode(fs.lstatSync(claims), true)) throw new ProgramCardDraftError("unavailable");

    const name = `${process.pid}-${randomUUID()}.lock`;
    const claim = path.join(claims, name);
    const release = () => { try { fs.unlinkSync(claim); } catch {  } };
    const fd = fs.openSync(claim, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ birth: processBirth(process.pid) }), "utf8"); }
    catch (error) { release(); throw error; }
    finally { fs.closeSync(fd); }
    try {
      for (const other of fs.readdirSync(claims)) {
        if (other === name) continue;
        const match = /^([1-9][0-9]*)-[0-9a-f-]{36}\.lock$/.exec(other);
        if (!match) throw new ProgramCardDraftError("busy");
        const target = path.join(claims, other);
        let otherFd                    ;
        try {
          otherFd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
          const info = fs.fstatSync(otherFd);
          if (!privateMode(info, false) || info.size > 512) throw new ProgramCardDraftError("busy");
          let birth = "";
          try { const value = JSON.parse(fs.readFileSync(otherFd, "utf8")); birth = typeof value.birth === "string" ? value.birth : ""; }
          catch {  }
          if (ownerAlive(Number(match[1]), birth)) throw new ProgramCardDraftError("busy");
          try { fs.unlinkSync(target); } catch (error     ) { if (error?.code !== "ENOENT") throw error; }
        } catch (error     ) { if (error?.code !== "ENOENT") throw error; }
        finally { if (otherFd !== undefined) fs.closeSync(otherFd); }
      }
      return release;
    } catch (error) { release(); throw error; }
  }

  function syncDirectory() {
    if (process.platform === "win32") return;
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | noFollow);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  function transaction   (draftId        , action         )    {
    checkDirectory(true);
    let release            ;
    try { release = claimWriter(); }
    catch (e) { throw e instanceof ProgramCardDraftError ? e : new ProgramCardDraftError("save_failed"); }
    try {

      for (const name of fs.readdirSync(directory)) {
        if (/^\.pending-[0-9a-f-]{36}$/.test(name)) fs.unlinkSync(path.join(directory, name));
      }
      if (!readCollection()) {

        const ids = rawRecords().filter(r => r.promotion?.status !== "saved")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.draftId.localeCompare(b.draftId))
          .slice(-PROGRAM_CARD_DRAFT_LIMIT).map(r => r.draftId);
        commitCollection(ids, draftId);
      }
      return action();
    } catch (e) { throw e instanceof ProgramCardDraftError ? e : new ProgramCardDraftError("save_failed", draftId); }
    finally {
      try { cleanUnlisted(); } catch {  }
      release();
    }
  }
  function commitBytes(target        , value         , draftId        ) {
    const temporary = path.join(directory, `.pending-${randomUUID()}`);
    let fd                    ;
    let committed = false;
    try {
      const bytes = JSON.stringify(value);
      if (Buffer.byteLength(bytes) > MAX_RECORD_BYTES) throw new ProgramCardDraftError("invalid_snapshot");
      fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
      fs.writeFileSync(fd, bytes, "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, target); committed = true;
      syncDirectory();
    } catch (e) {
      if (committed) throw new ProgramCardDraftError("outcome_unknown", draftId);
      throw e;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch {  }
    }
  }
  function commit(record                        )                         {

    let whole      = null;
    try { whole = readFile(record.draftId)?.whole ?? null; } catch { whole = null; }
    const carried = whole ? carryUnknownFields(whole, record, PROGRAM_CARD_DRAFT_SAVED_SHAPE) : record;
    commitBytes(filename(record.draftId), Buffer.byteLength(JSON.stringify(carried), "utf8") <= MAX_RECORD_BYTES ? carried : record, record.draftId);
    return record;
  }
  function current(draftId        , expected                         )                         {
    if (!validVersion(expected)) throw new ProgramCardDraftError("invalid_version");
    const record = read(draftId);
    if (!record) throw new ProgramCardDraftError("not_found");
    if (record.revision !== expected.revision || record.checkpointSeq !== expected.checkpointSeq)
      throw new ProgramCardDraftError("conflict");
    if (record.revision === Number.MAX_SAFE_INTEGER || record.checkpointSeq === Number.MAX_SAFE_INTEGER)
      throw new ProgramCardDraftError("version_exhausted");
    return record;
  }

  function create(snapshot                          , base                       ,
    origin                                                      )                         {
    const value = jsonSnapshot(snapshot);
    if (base && !validBase(base)) throw new ProgramCardDraftError("invalid_base");
    const draftId = randomUUID();
    return transaction(draftId, () => {
      if (read(draftId)) throw new ProgramCardDraftError("conflict");
      const now = new Date().toISOString();
      const record = commit({ version: 1, draftId, ownerHash, revision: 1, checkpointSeq: 0,
        createdAt: now, updatedAt: now, ...value, ...(base ? { base: { ...base } } : {}),
        ...(origin ? derivedStamp(origin.kit, origin.changed) : kitStamp()) });
      const ids = readCollection() .ids.filter(id => {
        const old = readRaw(id); return old && old.promotion?.status !== "saved";
      });

      commitCollection([...ids, draftId].slice(-PROGRAM_CARD_DRAFT_LIMIT), draftId);
      return record;
    });
  }
  function edit(draftId        , expected                         , snapshot                          )                         {
    const value = jsonSnapshot(snapshot);
    filename(draftId);
    return transaction(draftId, () => {
      const record = current(draftId, expected);
      if (record.promotion) throw new ProgramCardDraftError("promotion_pending_or_saved");

      const { kit: keptKit, ...rest } = record;
      const stamp = derivedStamp(keptKit, value.source !== record.source);
      return commit({ ...rest, ...value, ...stamp, revision: record.revision + 1,
        checkpointSeq: record.checkpointSeq + 1, updatedAt: new Date().toISOString() });
    });
  }
  function checkpoint(draftId        , expected                         , state         )                         {
    filename(draftId);
    return transaction(draftId, () => {
      const record = current(draftId, expected);
      if (record.promotion) throw new ProgramCardDraftError("promotion_pending_or_saved");
      const value = jsonSnapshot({ ...record, state });
      return commit({ ...record, ...value, checkpointSeq: record.checkpointSeq + 1, updatedAt: new Date().toISOString() });
    });
  }
  function discard(draftId        , expected                         )          {
    filename(draftId);
    return transaction(draftId, () => {
      if (!read(draftId)) return false;
      current(draftId, expected);
      commitCollection(readCollection() .ids.filter(id => id !== draftId), draftId);
      fs.unlinkSync(filename(draftId));
      try { syncDirectory(); } catch { throw new ProgramCardDraftError("outcome_unknown", draftId); }
      return true;
    });
  }

  function promote(draftId        , expected                         ,
    promoteOnce                                                         , target         )                         {
    filename(draftId);
    return transaction(draftId, () => {
      let record = current(draftId, expected);
      const appId = target || `draft-${draftId}`;
      if (appId !== `draft-${draftId}` && appId !== record.base?.appId) throw new ProgramCardDraftError("invalid_target");
      if (record.promotion && record.promotion.appId !== appId) throw new ProgramCardDraftError("promotion_target_conflict");
      if (record.promotion?.status === "saved") return record;
      if (!record.promotion) record = commit({ ...record, promotion: { appId, status: "pending" } });
      promoteOnce(record, appId);
      return commit({ ...record, promotion: { appId, status: "saved" } });
    });
  }

  function unpromote(draftId        , appId        )                         {
    filename(draftId);
    return transaction(draftId, () => {
      const record = read(draftId);
      if (!record) throw new ProgramCardDraftError("not_found");
      if (!record.promotion) return record;
      if (record.promotion.appId !== appId) throw new ProgramCardDraftError("promotion_target_conflict");
      const { promotion: _promotion, ...draft } = record;
      return commit(draft);
    });
  }
  function list()                           {
    if (!checkDirectory()) return [];
    const ids = collection().ids;
    const records = rawRecords();
    return [...ids.map(id => records.find(r => r.draftId === id)).filter(Boolean),
      ...records.filter(r => !ids.includes(r.draftId) && r.promotion?.status === "saved")]                            ;
  }

  function reconcilePromotion(draftId        , lookup                                                                                    ) {
    return transaction(draftId, () => {
      const record = read(draftId);
      if (!record || record.promotion?.status !== "pending") return record;
      const status = lookup(record.promotion.appId, record);
      if (status === "unknown") return record;
      if (status === "saved") return commit({ ...record, promotion: { ...record.promotion, status: "saved" } });
      const { promotion: _promotion, ...draft } = record;
      return commit(draft);
    });
  }
  return { create, read, list, edit, checkpoint, discard, promote, unpromote, reconcilePromotion };
}

module.exports = { PROGRAM_CARD_DRAFT_SAVED_SHAPE, PROGRAM_CARD_DRAFT_LIST_SAVED_SHAPE, ProgramCardDraftError, PROGRAM_CARD_DRAFT_LIMIT, PROGRAM_CARD_DRAFT_READ_STATE_BYTES, createProgramCardDraftStore };
