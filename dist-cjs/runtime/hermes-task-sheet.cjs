const { TASK_SYNC_ERRORS, curateSync } = require("../domain/task-run-facts.cjs");

const TASK_SHEET_SAVE_FRAME = "ocuclaw.task.sheet.save";
const TASK_SHEET_RUN_FRAME = "ocuclaw.task.sheet.run";
const TASK_SHEET_QUIET_FRAME = "ocuclaw.task.sheet.quiet";
const TASK_SHEET_RESULT_FRAME = "ocuclaw.task.sheet.result";
const TASK_SHEET_VERSION = 1;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LIBRARY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CODE = /^[a-z0-9_]{1,64}$/;
const STATE = /^[a-z_]{1,32}$/;
const KINDS = new Set(["brief", "reminder", "alert"]);

const SAVE_KEYS = new Set([
  "type", "requestId", "name", "kind", "when", "request", "starter", "popUp", "look", "monitorUrl", "fromJob", "presentation",

  "testId",

  "card",

  "cardPart",

  "starterCard",
]);
const STARTER_CREATE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TEST_ID = /^[a-z0-9]{8,40}$/;
const CARD_BUILD_HANDLE = /^[A-Za-z0-9_-]{8,80}$/;

const CARD_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const CARD_KEYS_MAX = 8;

const STARTER_CARD_ID = /^[a-z][a-z0-9-]{0,63}$/;

const STARTER_LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const STARTER_CHECK_ID = /^[a-f0-9]{16}$/;

const CARD_PART_SLOT = /^task(_[a-z][a-z0-9_]{0,18})?$/;
const NAME_MAX = 120;
const REQUEST_MAX = 4000;
const MONITOR_URL_MAX = 500;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const line = (v     , limit        ) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v);

const requestText = (v     ) => typeof v === "string" && v.length <= REQUEST_MAX &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);

function taskSheetSaveRequestIdOf(raw     )                {
  return record(raw) && raw.type === TASK_SHEET_SAVE_FRAME &&
    typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) ? raw.requestId : null;
}

function taskSheetSave(raw     )      {
  if (!record(raw) || raw.type !== TASK_SHEET_SAVE_FRAME) return null;
  if (Object.keys(raw).some((key) => !SAVE_KEYS.has(key))) return null;
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) return null;
  if (!line(raw.name, NAME_MAX) || !KINDS.has(raw.kind)) return null;
  if (!Object.hasOwn(raw, "when") || (raw.when !== null && !record(raw.when))) return null;
  if (raw.request !== undefined && !requestText(raw.request)) return null;
  if (raw.starter !== undefined && !record(raw.starter)) return null;
  if (raw.popUp !== undefined && typeof raw.popUp !== "boolean") return null;
  if (raw.look !== undefined && !record(raw.look)) return null;
  if (raw.presentation !== undefined && (!record(raw.presentation) ||
      Object.keys(raw.presentation).sort().join(",") !== "digest,proposalId" ||
      !/^[0-9a-f-]{36}$/.test(raw.presentation.proposalId || "") || !/^sha256:[a-f0-9]{64}$/.test(raw.presentation.digest || "") ||
      raw.starter !== undefined || raw.fromJob !== undefined)) return null;
  if (raw.monitorUrl !== undefined && !line(raw.monitorUrl, MONITOR_URL_MAX)) return null;
  if (raw.testId !== undefined && (typeof raw.testId !== "string" || !TEST_ID.test(raw.testId))) return null;

  if (raw.card !== undefined && (!record(raw.card) || Object.keys(raw.card).join(",") !== "handle" ||
      typeof raw.card.handle !== "string" || !CARD_BUILD_HANDLE.test(raw.card.handle) || raw.testId === undefined ||
      raw.presentation !== undefined || raw.fromJob !== undefined)) return null;

  if (raw.cardPart !== undefined && (!cardPartOk(raw.cardPart) || raw.testId === undefined || raw.card !== undefined ||
      raw.presentation !== undefined || raw.fromJob !== undefined)) return null;

  if (raw.starterCard !== undefined && (!record(raw.starterCard) ||
      Object.keys(raw.starterCard).sort().join(",") !== "id,key" ||
      typeof raw.starterCard.id !== "string" || !STARTER_CARD_ID.test(raw.starterCard.id) ||
      typeof raw.starterCard.key !== "string" || !STARTER_CREATE_KEY.test(raw.starterCard.key) ||
      raw.testId === undefined || raw.card !== undefined || raw.cardPart !== undefined ||
      raw.presentation !== undefined || raw.fromJob !== undefined)) return null;

  if (raw.fromJob !== undefined && (typeof raw.fromJob !== "string" || !JOB_ID.test(raw.fromJob) || raw.starter !== undefined)) {
    return null;
  }

  if (raw.starter === undefined && raw.fromJob === undefined &&
      (!requestText(raw.request) || !raw.request.trim())) return null;
  const input      = { name: raw.name.trim(), kind: raw.kind, when: raw.when };
  if (typeof raw.request === "string" && raw.request.trim()) input.request = raw.request;
  if (raw.starter !== undefined) input.starter = raw.starter;
  if (raw.popUp === false) input.popUp = false;
  if (raw.look !== undefined) input.look = raw.look;
  if (raw.monitorUrl !== undefined) input.monitorUrl = raw.monitorUrl;
  if (raw.fromJob !== undefined) input.fromJob = raw.fromJob;
  if (raw.presentation !== undefined) input.presentation = raw.presentation;
  if (raw.testId !== undefined) input.testId = raw.testId;
  if (raw.card !== undefined) input.card = { handle: raw.card.handle };
  if (raw.cardPart !== undefined) input.cardPart = { cardId: raw.cardPart.cardId, slot: raw.cardPart.slot };
  if (raw.starterCard !== undefined) input.starterCard = { id: raw.starterCard.id, key: raw.starterCard.key };
  return { requestId: raw.requestId, input };
}

function cardPartOk(part     )          {
  return record(part) && Object.keys(part).sort().join(",") === "cardId,slot" && typeof part.cardId === "string" &&
    LIBRARY_ID.test(part.cardId) && typeof part.slot === "string" && CARD_PART_SLOT.test(part.slot);
}

const TASK_TEST_RUN_FRAME = "ocuclaw.task.test.run";
const TASK_TEST_ACT_FRAME = "ocuclaw.task.test.act";
const TASK_TEST_STOP_FRAME = "ocuclaw.task.test.stop";
const TASK_TEST_DROP_FRAME = "ocuclaw.task.test.drop";

const TASK_STARTER_REPORT_FRAME = "ocuclaw.task.test.starter.report";

const TASK_CARD_DROP_FRAME = "ocuclaw.task.card.drop";

const TASK_CARD_SAVE_FRAME = "ocuclaw.task.card.save";

const TASK_CARD_UNDO_FRAME = "ocuclaw.task.card.undo";
const TEST_ACTIONS = new Set(["uses_allow", "uses_keep_off", "uses_undo"]);
const USE_KEY_MAX = 512;

function taskTestRequest(raw     )      {

  if (record(raw) && raw.type === TASK_CARD_DROP_FRAME) {
    return Object.keys(raw).sort().join(",") === "handle,type" && typeof raw.handle === "string" &&
      CARD_BUILD_HANDLE.test(raw.handle) ? { op: "card_drop", handle: raw.handle } : null;
  }

  if (record(raw) && raw.type === TASK_CARD_SAVE_FRAME) {
    const keys = Object.keys(raw).sort().join(",");

    if (keys === "requestId,starterCard,taskId,testId,type") {
      return typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) &&
        typeof raw.taskId === "string" && LIBRARY_ID.test(raw.taskId) &&
        typeof raw.starterCard === "string" && STARTER_CARD_ID.test(raw.starterCard) &&
        typeof raw.testId === "string" && TEST_ID.test(raw.testId)
        ? { op: "card_save", requestId: raw.requestId, taskId: raw.taskId, starterCard: raw.starterCard, testId: raw.testId } : null;
    }
    if (keys !== "handle,requestId,taskId,testId,type" && keys !== "addTo,handle,requestId,taskId,testId,type") return null;
    if (raw.addTo !== undefined && (typeof raw.addTo !== "string" || !LIBRARY_ID.test(raw.addTo))) return null;
    return typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) &&
      typeof raw.taskId === "string" && LIBRARY_ID.test(raw.taskId) &&
      typeof raw.handle === "string" && CARD_BUILD_HANDLE.test(raw.handle) &&
      typeof raw.testId === "string" && TEST_ID.test(raw.testId)
      ? { op: "card_save", requestId: raw.requestId, taskId: raw.taskId, handle: raw.handle, testId: raw.testId,
        ...(raw.addTo ? { addTo: raw.addTo } : {}) } : null;
  }

  if (record(raw) && raw.type === TASK_CARD_UNDO_FRAME) {
    return Object.keys(raw).sort().join(",") === "cardId,requestId,taskId,type" &&
      typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) &&
      typeof raw.taskId === "string" && LIBRARY_ID.test(raw.taskId) &&
      typeof raw.cardId === "string" && LIBRARY_ID.test(raw.cardId)
      ? { op: "card_undo", requestId: raw.requestId, taskId: raw.taskId, cardId: raw.cardId } : null;
  }
  if (!record(raw) || typeof raw.testId !== "string" || !TEST_ID.test(raw.testId)) return null;
  const requestId = typeof raw.requestId === "string" && REQUEST_ID.test(raw.requestId) ? raw.requestId : null;
  if (raw.type === TASK_TEST_DROP_FRAME) {
    return Object.keys(raw).sort().join(",") === "testId,type" ? { op: "test_drop", testId: raw.testId } : null;
  }
  if (!requestId) return null;
  if (raw.type === TASK_TEST_STOP_FRAME) {
    return Object.keys(raw).sort().join(",") === "requestId,testId,type" ? { op: "test_stop", requestId, testId: raw.testId } : null;
  }
  if (raw.type === TASK_TEST_ACT_FRAME) {
    if (Object.keys(raw).sort().join(",") !== "action,requestId,testId,type,useKey") return null;
    if (!TEST_ACTIONS.has(raw.action) || !line(raw.useKey, USE_KEY_MAX)) return null;
    return { op: "test_act", requestId, testId: raw.testId, action: raw.action, useKey: raw.useKey };
  }

  if (raw.type === TASK_STARTER_REPORT_FRAME) {
    if (Object.keys(raw).sort().join(",") !== "checkId,report,requestId,testId,type") return null;
    if (typeof raw.checkId !== "string" || !STARTER_CHECK_ID.test(raw.checkId) || !record(raw.report)) return null;
    return { op: "test_starter_report", requestId, testId: raw.testId, checkId: raw.checkId, report: raw.report };
  }
  if (raw.type !== TASK_TEST_RUN_FRAME) return null;
  const { testId, type: _type, openCard, cardKeys, cardPart, starterCard, starterLocale, ...draft } = raw;
  const keysOk = (keys     ) => Array.isArray(keys) && keys.length >= 1 && keys.length <= CARD_KEYS_MAX &&
    keys.every((key     ) => typeof key === "string" && CARD_KEY.test(key)) && new Set(keys).size === keys.length;

  if (starterCard !== undefined && (openCard !== true || cardKeys !== undefined || cardPart !== undefined ||
    typeof starterCard !== "string" || !STARTER_CARD_ID.test(starterCard))) return null;

  if (starterLocale !== undefined && (starterCard === undefined || typeof starterLocale !== "string" ||
    !STARTER_LOCALE.test(starterLocale))) return null;
  const starter = starterCard !== undefined ? { starterCard, ...(starterLocale !== undefined ? { starterLocale } : {}) } : {};

  if (Object.hasOwn(raw, "taskId")) {
    if (Object.keys(draft).some((key) => key !== "requestId" && key !== "taskId")) return null;
    if (openCard !== true || typeof raw.taskId !== "string" || !LIBRARY_ID.test(raw.taskId)) return null;
    if (cardKeys !== undefined && !keysOk(cardKeys)) return null;

    if (cardPart !== undefined && (cardKeys !== undefined || !cardPartOk(cardPart))) return null;
    return { op: "test_run", requestId, testId, taskId: raw.taskId,
      ...(cardPart ? { cardPart: { cardId: cardPart.cardId, slot: cardPart.slot } } : {}), ...starter,
      input: { openCard: true, ...(cardKeys ? { cardKeys: [...cardKeys] } : {}) } };
  }

  if (cardPart !== undefined && (openCard !== true || cardKeys !== undefined || !cardPartOk(cardPart))) return null;
  if (["presentation", "fromJob", "monitorUrl", "popUp"].some((key) => Object.hasOwn(draft, key))) return null;

  if (openCard !== undefined && openCard !== true) return null;

  if (cardKeys !== undefined && (openCard !== true || !Array.isArray(cardKeys) || cardKeys.length < 1 || cardKeys.length > CARD_KEYS_MAX
    || cardKeys.some((key     ) => typeof key !== "string" || !CARD_KEY.test(key)) || new Set(cardKeys).size !== cardKeys.length)) return null;
  const curated = taskSheetSave({ ...draft, type: TASK_SHEET_SAVE_FRAME });
  if (!curated) return null;
  if (!openCard) return { op: "test_run", requestId, testId, input: curated.input };
  return { op: "test_run", requestId, testId, ...(cardPart ? { cardPart: { cardId: cardPart.cardId, slot: cardPart.slot } } : {}), ...starter,
    input: { ...curated.input, openCard: true, ...(cardKeys ? { cardKeys: [...cardKeys] } : {}) } };
}

function taskSheetTaskFrame(raw     , type        )      {
  if (!record(raw) || raw.type !== type) return null;
  if (Object.keys(raw).sort().join(",") !== "requestId,taskId,type") return null;
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) return null;
  if (typeof raw.taskId !== "string" || !LIBRARY_ID.test(raw.taskId)) return null;
  return { requestId: raw.requestId, taskId: raw.taskId };
}

function taskSheetRun(raw     )      {
  return taskSheetTaskFrame(raw, TASK_SHEET_RUN_FRAME);
}

function taskSheetQuiet(raw     )      {
  return taskSheetTaskFrame(raw, TASK_SHEET_QUIET_FRAME);
}

const RESULT_STATUS                         = { save: "saved", run: "ran", quiet: "quieted", card: "saved", card_undo: "undone" };

function succeeded(op        , outcome     )          {
  if (!record(outcome)) return false;
  if (op === "save" || op === "card") return outcome.status === "saved" && LIBRARY_ID.test(outcome.taskId || "");
  if (op === "card_undo") return outcome.status === "undone" && LIBRARY_ID.test(outcome.taskId || "");
  if (op === "run") return outcome.status === "accepted" && outcome.state !== "job_missing";

  return (outcome.status === "saved" && outcome.applied === "now") || outcome.status === "unchanged";
}

function taskSheetResult(op                                                 , requestId        , outcome     )      {
  const ok = succeeded(op, outcome);
  const out      = { requestId, op, status: ok ? RESULT_STATUS[op] : "rejected" };
  if (record(outcome)) {
    if (typeof outcome.taskId === "string" && LIBRARY_ID.test(outcome.taskId)) out.taskId = outcome.taskId;
    if (op === "save" && line(outcome.name, NAME_MAX)) out.name = outcome.name;

    const card = (op === "save" || op === "card") && ok && record(outcome.card) ? outcome.card : null;

    const starter = card && typeof card.starter === "string" && STARTER_CARD_ID.test(card.starter) ? card.starter : null;
    if (card && typeof card.appId === "string" && LIBRARY_ID.test(card.appId) && Number.isSafeInteger(card.revision) &&
        (starter || (typeof card.draftId === "string" && /^[0-9a-f-]{36}$/.test(card.draftId)))) {
      out.card = { appId: card.appId, revision: card.revision, ...(starter ? { starter } : { draftId: card.draftId }),
        ...(line(card.name, NAME_MAX) ? { name: card.name } : {}),
        ...(typeof card.sourceHash === "string" && /^sha256:[a-f0-9]{64}$/.test(card.sourceHash) ? { sourceHash: card.sourceHash } : {}) };
    }

    const kept = (op === "save" || op === "card" || op === "card_undo") && ok && record(outcome.kept) ? outcome.kept : null;
    if (kept && Object.keys(kept).join(",") === "templateId" && typeof kept.templateId === "string" && LIBRARY_ID.test(kept.templateId) &&
        (op === "card_undo" || out.card)) {
      out.kept = { templateId: kept.templateId };
    }

    const part = op === "save" && ok && record(outcome.cardPart) ? outcome.cardPart : null;
    if (part?.status === "linked" && cardPartOk({ cardId: part.cardId, slot: part.slot })) {
      out.cardPart = { status: "linked", cardId: part.cardId, slot: part.slot };
    } else if (part?.status === "rejected" && typeof part.code === "string" && CODE.test(part.code)) {
      out.cardPart = { status: "rejected", code: part.code };
    }
    const state = typeof outcome.state === "string" ? outcome.state : null;
    if (state && STATE.test(state)) out.state = state;
    if (typeof outcome.code === "string" && CODE.test(outcome.code)) out.code = outcome.code;
    if (op === "save" && state === "unsynced" && record(outcome.sync)) {
      const sync = curateSync(outcome.sync);
      out.sync = { ...sync, code: sync.code !== null && TASK_SYNC_ERRORS.includes(sync.code) ? sync.code : null };
    }
  }
  if (out.status === "rejected" && !out.code) out.code = out.state === "job_missing" ? "task_job_missing" : "task_sheet_failed";
  return out;
}

function answerTaskSheetRequest(handler     , request     , options      = {})      {
  if (!handler || !record(request)) return null;
  if (request.op === "invalid_save") return { status: "rejected", code: "task_sheet_invalid" };
  if (request.op === "save" && typeof handler.saveTaskFromSheet === "function") {
    return handler.saveTaskFromSheet(request.input, request.context || {});
  }
  if (request.op === "run" && typeof handler.runTaskFromSheet === "function") return handler.runTaskFromSheet(request.taskId);
  const pageOptions = {
    ...(typeof options.recentResults === "function" ? { recentResults: options.recentResults } : {}),

    ...(typeof options.starterCard === "function" ? { starterCard: options.starterCard } : {}),
  };
  if (request.op === "page" && typeof handler.readTaskPage === "function") {
    return handler.readTaskPage(request.taskId, pageOptions);
  }
  if (request.op === "act" && typeof handler.actOnTaskPage === "function") {

    const input = request.action === "set_page"
      ? { monitorUrl: typeof request.monitorUrl === "string" ? request.monitorUrl : null }
      : typeof request.useKey === "string" ? { useKey: request.useKey } : {};
    return handler.actOnTaskPage(request.taskId, request.action, request.expectedDigest, pageOptions, input);
  }

  if (request.op === "quiet" && typeof handler.quietTaskFromSheet === "function") return handler.quietTaskFromSheet(request.taskId);
  return null;
}

function formatTaskSheetResult(result     )         {
  return JSON.stringify({ type: TASK_SHEET_RESULT_FRAME, v: TASK_SHEET_VERSION, ...result });
}

module.exports = { TASK_SHEET_SAVE_FRAME, TASK_SHEET_RUN_FRAME, TASK_SHEET_QUIET_FRAME, TASK_SHEET_RESULT_FRAME, TASK_SHEET_VERSION, taskSheetSaveRequestIdOf, taskSheetSave, TASK_TEST_RUN_FRAME, TASK_TEST_ACT_FRAME, TASK_TEST_STOP_FRAME, TASK_TEST_DROP_FRAME, TASK_STARTER_REPORT_FRAME, TASK_CARD_DROP_FRAME, TASK_CARD_SAVE_FRAME, TASK_CARD_UNDO_FRAME, taskTestRequest, taskSheetRun, taskSheetQuiet, taskSheetResult, answerTaskSheetRequest, formatTaskSheetResult };
