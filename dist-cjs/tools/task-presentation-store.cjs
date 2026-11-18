const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { atomicWriteLiveuiLibraryRecord, liveuiLibraryDigest, PROGRAM_CARD_SOURCE_MAX } = require("./glasses-ui-library.cjs");
const { taskPresentation, taskPresentationDigest } = require("./glasses-ui-task-presentation.cjs");

const TASK_PRESENTATION_RECORD_MAX_BYTES = 100_000 + PROGRAM_CARD_SOURCE_MAX * 6;

const TASK_PRESENTATION_SAVED_SHAPE             = Object.freeze({
  fields: ["version", "ownerHash", "proposalId", "digest", "presentationDigest", "candidate", "createdAtMs", "phase",
    "revisionTarget", "draft", "saveInputDigest", "taskId", "saved", "failure"],
});
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
class TaskPresentationError extends Error {
  code        ;
  constructor(code        ) { super(code); this.name = "TaskPresentationError"; this.code = code; }
}

function createTaskPresentationStore(stateDir        , ownerKey        ) {
  if (!path.isAbsolute(stateDir) || !ownerKey) throw new TaskPresentationError("presentation_owner_invalid");
  const ownerHash = liveuiLibraryDigest(ownerKey).slice("sha256:".length);
  const root = path.join(stateDir, "task-presentations-v1");
  const directory = path.join(root, ownerHash);
  const file = (id        ) => {
    if (!ID.test(id)) throw new TaskPresentationError("presentation_not_found");
    return path.join(directory, `${id}.json`);
  };
  function dirs(create = false) {
    for (const dir of [root, directory]) {
      if (create) { try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e     ) { if (e.code !== "EEXIST") throw e; } }
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TaskPresentationError("presentation_unavailable");
    }
  }
  function write(record     ) {
    dirs(true);
    const targetPath = file(record.proposalId);
    const written = atomicWriteLiveuiLibraryRecord({ fs, libraryDir: root, targetPath, record });
    if (written.status !== "written") throw new TaskPresentationError("presentation_save_failed");
    for (const target of [targetPath, directory]) {
      const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return record;
  }
  function read(id        ) {
    try {
      dirs();
      const target = file(id), stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > TASK_PRESENTATION_RECORD_MAX_BYTES) throw new TaskPresentationError("presentation_unavailable");
      const record = JSON.parse(fs.readFileSync(target, "utf8"));
      if (record.version !== 1 || record.ownerHash !== ownerHash || record.proposalId !== id ||
          record.digest !== liveuiLibraryDigest(record.candidate) || !taskPresentation(record.candidate?.presentation)) {
        throw new TaskPresentationError("presentation_invalid");
      }
      return record;
    } catch (e     ) {
      if (e.code === "ENOENT") throw new TaskPresentationError("presentation_not_found");
      throw e;
    }
  }
  function create(candidate     , revisionTarget      ) {
    const presentation = taskPresentation(candidate.presentation);
    if (!presentation) throw new TaskPresentationError("presentation_invalid");
    const stored = { ...candidate, presentation };
    return write({ version: 1, ownerHash, proposalId: randomUUID(), digest: liveuiLibraryDigest(stored),
      presentationDigest: taskPresentationDigest(presentation), candidate: stored, createdAtMs: Date.now(), phase: "proposed",
      ...(revisionTarget ? { revisionTarget } : {}) });
  }

  function transition(id        , digest        , from          , patch     ) {
    const previous = read(id);
    if (previous.digest !== digest || !from.includes(previous.phase)) throw new TaskPresentationError("presentation_conflict");
    const allowed = new Set(["phase", "draft", "saveInputDigest", "taskId", "saved", "failure"]);
    if (Object.keys(patch).some(k => !allowed.has(k))) throw new TaskPresentationError("presentation_invalid");
    return write({ ...previous, ...patch });
  }
  return { create, read, transition };
}

module.exports = { TASK_PRESENTATION_RECORD_MAX_BYTES, TASK_PRESENTATION_SAVED_SHAPE, TaskPresentationError, createTaskPresentationStore };
