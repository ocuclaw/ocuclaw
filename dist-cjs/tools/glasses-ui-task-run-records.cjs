const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, canonicalSerialize, isValidLiveuiLibraryItemId, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");

const LIVEUI_TASK_RUN_RECORD_SCHEMA = 1;
const LIVEUI_TASK_RUN_RECORD_DIRNAME = "task-runs-v1";
const LIVEUI_TASK_RUN_RECORD_MAX = 10;
const LIVEUI_TASK_RUN_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function projectTaskRunRecord(input = {}) {
  const executor = input && input.executor && typeof input.executor === "object"
    ? input.executor
    : {};
  const approvals = Array.isArray(input && input.approvals) ? input.approvals : [];
  return {
    schema: LIVEUI_TASK_RUN_RECORD_SCHEMA,
    recordId: input.recordId,
    runId: input.runId,
    taskId: input.taskId,
    versionId: input.versionId,
    executor: {
      host: executor.host,
      agentId: executor.agentId,
    },
    context: input.context,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    toolNames: Array.isArray(input.toolNames)
      ? input.toolNames.filter((name) => typeof name === "string")
      : [],
    approvals: approvals
      .filter((approval) => approval && typeof approval === "object")
      .map((approval) => ({
        toolName: approval.toolName,
        outcome: approval.outcome,
      })),
    outcome: input.outcome !== undefined ? input.outcome : input.endedReason,
    delivery: input.delivery,
  };
}

function pruneTaskRunRecords(records, nowMs) {
  const cutoff = nowMs - LIVEUI_TASK_RUN_RECORD_TTL_MS;
  return (Array.isArray(records) ? records : [])
    .filter((record) => record && Number.isFinite(record.endedAt) && record.endedAt >= cutoff)
    .sort((left, right) => right.endedAt - left.endedAt)
    .slice(0, LIVEUI_TASK_RUN_RECORD_MAX)
    .map((record) => projectTaskRunRecord(record));
}

function createLiveuiTaskRunRecordStore(opts = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const rootDir = resolveLiveuiLibraryRoot(opts.rootDir);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const recordsDir = path.join(rootDir, LIVEUI_TASK_RUN_RECORD_DIRNAME);

  function taskPath(taskId) {
    if (!isValidLiveuiLibraryItemId(taskId)) {
      throw new Error("LiveUI Task Run Record taskId is invalid");
    }
    return path.join(recordsDir, `${taskId}.json`);
  }

  function loadDocument(taskId) {
    const targetPath = taskPath(taskId);
    try {
      const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        parsed.schema !== LIVEUI_TASK_RUN_RECORD_SCHEMA ||
        !Array.isArray(parsed.records)
      ) return { targetPath, records: [] };
      return { targetPath, records: parsed.records };
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.name === "SyntaxError")) {
        return { targetPath, records: [] };
      }
      throw err;
    }
  }

  function write(targetPath, records) {
    atomicWriteLiveuiLibraryRecord({
      fs,
      libraryDir: rootDir,
      targetPath,
      record: { schema: LIVEUI_TASK_RUN_RECORD_SCHEMA, records },
    });
  }

  return {
    rootDir,
    recordsDir,
    append(record) {
      const projected = projectTaskRunRecord(record);
      const loaded = loadDocument(projected.taskId);
      const records = pruneTaskRunRecords([projected, ...loaded.records], now());
      write(loaded.targetPath, records);
      return projected;
    },
    list(taskId) {
      const loaded = loadDocument(taskId);
      const records = pruneTaskRunRecords(loaded.records, now());
      if (canonicalSerialize(records) !== canonicalSerialize(loaded.records)) {
        write(loaded.targetPath, records);
      }
      return records;
    },
    deleteForTask(taskId) {
      const targetPath = taskPath(taskId);
      try {
        fs.unlinkSync(targetPath);
      } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
      return { status: "deleted", taskId };
    },
  };
}

module.exports = { LIVEUI_TASK_RUN_RECORD_SCHEMA, LIVEUI_TASK_RUN_RECORD_DIRNAME, LIVEUI_TASK_RUN_RECORD_MAX, LIVEUI_TASK_RUN_RECORD_TTL_MS, projectTaskRunRecord, pruneTaskRunRecords, createLiveuiTaskRunRecordStore };
