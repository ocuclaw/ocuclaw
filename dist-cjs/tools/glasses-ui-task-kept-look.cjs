const { isValidLiveuiLibraryItemId } = require("./glasses-ui-library.cjs");
const { taskLookTemplateId } = require("./glasses-ui-task-schedule.cjs");

const TASK_KEPT_LOOK_DIR = "task-kept-looks-v1";

function isPlainObject(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function taskKeptLookFor(plan     )                                           {
  if (!isPlainObject(plan)) return null;
  if (isPlainObject(plan.look)) {
    if (plan.look.kind !== "template" || !isValidLiveuiLibraryItemId(plan.look.templateId)) return null;
    return { look: { kind: "template", templateId: plan.look.templateId }, templateId: plan.look.templateId };
  }
  const starter = taskLookTemplateId(plan);
  return typeof starter === "string" && isValidLiveuiLibraryItemId(starter) ? { look: null, templateId: starter } : null;
}

const TASK_KEPT_LOOK_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "taskId", "cardId", "look", "templateId", "keptAtMs"],
  parts: { look: { fields: ["kind", "templateId"] } },
});

function validTaskKeptLook(record     , taskId        ) {
  if (!isPlainObject(record) || record.schemaVersion !== 1 || record.taskId !== taskId) return null;
  if (!isValidLiveuiLibraryItemId(record.cardId) || !isValidLiveuiLibraryItemId(record.templateId)) return null;
  if (!Number.isSafeInteger(record.keptAtMs) || record.keptAtMs < 0) return null;
  let look      = null;
  if (record.look !== null) {
    if (!isPlainObject(record.look) ||
        record.look.kind !== "template" || !isValidLiveuiLibraryItemId(record.look.templateId)) return null;
    look = { kind: "template", templateId: record.look.templateId };
  }
  return { schemaVersion: 1, taskId, cardId: record.cardId, look, templateId: record.templateId, keptAtMs: record.keptAtMs };
}

module.exports = { TASK_KEPT_LOOK_DIR, taskKeptLookFor, TASK_KEPT_LOOK_SAVED_SHAPE, validTaskKeptLook };
