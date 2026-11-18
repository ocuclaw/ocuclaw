const nodeFs = require("node:fs");

const path = require("node:path");

const { atomicWriteLiveuiLibraryRecord, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const TASK_CHECK_AGAIN_FILENAME = "task-check-again-v1.json";

const TASK_CHECK_AGAIN_NOT_ALLOWED = "check_again_not_allowed";
const TASK_CHECK_AGAIN_LIMITS = Object.freeze({
  maxTasks: 512,

  maxPerFrame: 8,

  nameChars: 60,
  sendChars: 40,
  sendsPerTask: 2,
});
const TASK_CHECK_AGAIN_VIAS = Object.freeze(["glasses", "phone"]);

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const L = TASK_CHECK_AGAIN_LIMITS;

const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const validCheckAgainTaskId = (value     ) => typeof value === "string" && TASK_ID.test(value);

function validRecord(raw     ) {
  if (!isPlainObject(raw) || !validCheckAgainTaskId(raw.taskId) || !Number.isSafeInteger(raw.atMs) || raw.atMs < 0 ||
      !TASK_CHECK_AGAIN_VIAS.includes(raw.via)) return null;
  if (Object.keys(raw).some(field => !["taskId", "atMs", "via"].includes(field))) return null;
  return { taskId: raw.taskId, atMs: raw.atMs, via: raw.via };
}

function createTaskCheckAgainStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const file = path.join(libraryDir, TASK_CHECK_AGAIN_FILENAME);

  function read()        {
    let doc     ;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      return [];
    }
    if (!isPlainObject(doc) || doc.schemaVersion !== 1 || !Array.isArray(doc.tasks)) return [];
    if (Object.keys(doc).some(field => field !== "schemaVersion" && field !== "tasks")) return [];
    const tasks        = [];
    const seen = new Set        ();
    for (const raw of doc.tasks) {
      const record = validRecord(raw);
      if (!record || seen.has(record.taskId)) return [];
      seen.add(record.taskId);
      tasks.push(record);
    }
    return tasks.sort((a, b) => b.atMs - a.atMs).slice(0, L.maxTasks);
  }

  function write(records       ) {
    const tasks = (Array.isArray(records) ? records : []).map(validRecord).filter(Boolean)
      .sort((a     , b     ) => b.atMs - a.atMs).slice(0, L.maxTasks);
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: { schemaVersion: 1, tasks } }).status === "written";
  }

  return { file, read, write };
}

function createTaskCheckAgain(deps      = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const store = deps.store || null;
  const records = () => (store ? store.read() : []);
  const changed = () => {
    try { deps.onChange?.(); } catch (_) {  }
  };
  const ids = (taskIds     ) => [...new Set((Array.isArray(taskIds) ? taskIds : []).filter(validCheckAgainTaskId))];

  return {

    allowed(taskId     ) {
      return validCheckAgainTaskId(taskId) && records().some((record     ) => record.taskId === taskId);
    },

    allow(taskIds     , via = "glasses") {
      const list = ids(taskIds);
      if (!list.length || list.length > L.maxPerFrame || !TASK_CHECK_AGAIN_VIAS.includes(via))
        return { status: "rejected", code: "check_again_invalid" };
      if (!store) return { status: "rejected", code: "check_again_unavailable" };
      const atMs = now();
      const rest = records().filter((record     ) => !list.includes(record.taskId));
      if (!store.write([...list.map(taskId => ({ taskId, atMs, via })), ...rest])) return { status: "rejected", code: "check_again_write_failed" };
      changed();
      return { status: "accepted", taskIds: list };
    },

    remove(taskIds     ) {
      const list = ids(taskIds);
      if (!list.length || list.length > L.maxPerFrame) return { status: "rejected", code: "check_again_invalid" };
      if (!store) return { status: "rejected", code: "check_again_unavailable" };
      const all = records();
      const rest = all.filter((record     ) => !list.includes(record.taskId));
      if (rest.length === all.length) return { status: "accepted", taskIds: [] };
      if (!store.write(rest)) return { status: "rejected", code: "check_again_write_failed" };
      changed();
      return { status: "accepted", taskIds: list };
    },
  };
}

const line = (value     , limit        ) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, limit) : "");

function taskCheckAgainAsk({ cardName, parts, nameOf, sendsOf }     ) {
  const asked = (Array.isArray(parts) ? parts : []).filter((part     ) =>
    part && part.code === TASK_CHECK_AGAIN_NOT_ALLOWED && validCheckAgainTaskId(part.taskId));
  if (!asked.length) return null;
  const tasks = asked.slice(0, 3).map((part     ) => {
    let name = "";
    try { name = line(nameOf?.(part.taskId), L.nameChars); } catch (_) { name = ""; }
    let sends        = [];
    try { sends = Array.isArray(sendsOf?.(part.taskId)) ? sendsOf(part.taskId) : []; } catch (_) { sends = []; }
    return {
      ...(typeof part.slot === "string" ? { slot: part.slot } : {}),
      taskId: part.taskId,
      name: name || part.taskId,
      sends: [...new Set(sends.map((send     ) => line(send, L.sendChars)).filter(Boolean))].slice(0, L.sendsPerTask),
    };
  });
  return { card: line(cardName, L.nameChars) || "this card", tasks };
}

function taskCheckAgainSends(record     )           {
  const entries = record && Array.isArray(record.entries) ? record.entries : [];
  return entries.filter((entry     ) => entry && entry.kind === "send")
    .map((entry     ) => (typeof entry.destination === "string" && entry.destination) || (typeof entry.tool === "string" && entry.tool) || "")
    .filter(Boolean);
}

module.exports = { TASK_CHECK_AGAIN_FILENAME, TASK_CHECK_AGAIN_NOT_ALLOWED, TASK_CHECK_AGAIN_LIMITS, TASK_CHECK_AGAIN_VIAS, validCheckAgainTaskId, createTaskCheckAgainStore, createTaskCheckAgain, taskCheckAgainAsk, taskCheckAgainSends };
