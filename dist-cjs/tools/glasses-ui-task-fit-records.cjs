const nodeFs = require("node:fs");

const path = require("node:path");

const { atomicWriteLiveuiLibraryRecord, isValidLiveuiLibraryItemId, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { validTaskFixes } = require("./glasses-ui-task-fit.cjs");

const { TASK_UNCHECKED_WHY } = require("./glasses-ui-task-unchecked.cjs");

const TASK_FIT_DIR = "task-fit-v1";
const SCHEMA_VERSION = 1;
const LABEL_MAX = 64;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const LOOK_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const record = (v         )                           => !!v && typeof v === "object" && !Array.isArray(v);

function labelOf(raw         )                {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? Array.from(text).slice(0, LABEL_MAX).join("") : null;
}

function taskFitRecordFor(input

 )                       {
  if (typeof input.deliveryId !== "string" || !ID_RE.test(input.deliveryId)) return null;
  const inputs = input.inputs.filter((entry) => record(entry) && KEY_RE.test(entry.key));
  const fixes = validTaskFixes(input.fixes, inputs.map((entry) => entry.key)) || {};
  const unchecked = record(input.unchecked) ? input.unchecked : {};
  const keys                     = [];
  for (const entry of inputs) {
    const out                   = { key: entry.key, label: labelOf(entry.label), ...(fixes[entry.key] || {}) };
    if (input.values[entry.key] === null) {
      const why = record(unchecked[entry.key]) ? unchecked[entry.key].why : null;
      out.why = (TASK_UNCHECKED_WHY                     ).includes(why) ? why : "other";
    }
    if (out.hidden || out.cut || out.dropped || out.why) keys.push(out);
  }
  return {
    taskId: input.taskId,
    deliveryId: input.deliveryId,
    source: input.source,
    atMs: input.atMs,
    inputs: inputs.length,
    look: typeof input.look === "string" && LOOK_RE.test(input.look) ? input.look : null,
    keys,
  };
}

function validRecord(raw         , taskId        )                       {
  if (!record(raw) || raw.schemaVersion !== SCHEMA_VERSION || raw.taskId !== taskId) return null;
  if (typeof raw.deliveryId !== "string" || !ID_RE.test(raw.deliveryId)) return null;
  if (raw.source !== "schedule" && raw.source !== "run") return null;
  if (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  if (!Number.isSafeInteger(raw.inputs) || raw.inputs < 1 || raw.inputs > 16) return null;
  if (!Array.isArray(raw.keys)) return null;
  const keys                     = [];
  for (const entry of raw.keys.slice(0, 16)) {
    if (!record(entry) || !KEY_RE.test(entry.key)) continue;
    const fix = validTaskFixes({ [entry.key]: entry }, [entry.key]);
    const why = (TASK_UNCHECKED_WHY                     ).includes(entry.why) ? entry.why : null;
    if (!fix && !why) continue;
    keys.push({ key: entry.key, label: labelOf(entry.label), ...(fix ? fix[entry.key] : {}), ...(why ? { why } : {}) });
  }
  return {
    taskId,
    deliveryId: raw.deliveryId,
    source: raw.source,
    atMs: raw.atMs,
    inputs: raw.inputs,
    look: typeof raw.look === "string" && LOOK_RE.test(raw.look) ? raw.look : null,
    keys,
  };
}

function taskFitForPhone(fit                      )                                       {
  if (!fit || !fit.keys.length) return null;
  const { taskId: _taskId, ...rest } = fit;
  return rest;
}

function createTaskFitStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const dir = path.join(libraryDir, TASK_FIT_DIR);
  const fileFor = (taskId        ) => path.join(dir, `${taskId}.json`);

  function read(taskId         )                       {
    if (!isValidLiveuiLibraryItemId(taskId)) return null;
    try {
      return validRecord(JSON.parse(fs.readFileSync(fileFor(taskId          ), "utf8")), taskId          );
    } catch (_) {
      return null;
    }
  }

  function clear(taskId         ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return;
    try {
      fs.unlinkSync(fileFor(taskId          ));
    } catch (_) {

    }
  }

  return {
    dir,
    read,
    clear,

    write(fit                      )          {
      if (!fit || !isValidLiveuiLibraryItemId(fit.taskId)) return false;
      try {
        const before = read(fit.taskId);
        if (before && before.atMs > fit.atMs) return false;
        return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: fileFor(fit.taskId),
          record: { schemaVersion: SCHEMA_VERSION, ...fit } }).status === "written";
      } catch (_) {
        return false;
      }
    },
  };
}

module.exports = { TASK_FIT_DIR, taskFitRecordFor, taskFitForPhone, createTaskFitStore };
