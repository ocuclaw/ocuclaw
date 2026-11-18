const TASK_PAGE_GET_FRAME = "ocuclaw.task.page.get";
const TASK_PAGE_ACT_FRAME = "ocuclaw.task.page.act";
const TASK_PAGE_FRAME = "ocuclaw.task.page";
const TASK_PAGE_VERSION = 1;

const LINK_TASK_RESULT_RECENT_METHOD = "task.result.recent";

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const LIBRARY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CODE = /^[a-z0-9_]{1,64}$/;

const ACTIONS = new Set(["pause", "resume", "delete", "review_starter", "approve_draft", "keep_current", "set_page", "sync",

  "uses_remove", "uses_allow", "uses_keep_off",

  "uses_mark_read", "uses_mark_change"]);
const USES_ACTIONS = new Set(["uses_remove", "uses_allow", "uses_keep_off", "uses_mark_read", "uses_mark_change"]);
const USE_KEY_MAX = 200;

const MONITOR_URL = /^https?:\/\/[!-~]{1,490}$/;
const TASKS_MAX = 100;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);

function taskPageGet(raw     )      {
  if (!record(raw) || raw.type !== TASK_PAGE_GET_FRAME) return null;
  const keys = Object.keys(raw);
  if (keys.some((key) => !["type", "requestId", "taskId"].includes(key))) return null;
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) return null;
  if (raw.taskId !== undefined && (typeof raw.taskId !== "string" || !LIBRARY_ID.test(raw.taskId))) return null;
  return { requestId: raw.requestId, taskId: raw.taskId === undefined ? null : raw.taskId };
}

function taskPageAct(raw     )      {
  if (!record(raw) || raw.type !== TASK_PAGE_ACT_FRAME) return null;
  const keys = Object.keys(raw);
  if (keys.some((key) => !["type", "requestId", "taskId", "action", "expectedDigest", "monitorUrl", "useKey"].includes(key))) {
    return null;
  }
  if (typeof raw.requestId !== "string" || !REQUEST_ID.test(raw.requestId)) return null;
  if (typeof raw.taskId !== "string" || !LIBRARY_ID.test(raw.taskId)) return null;
  if (!ACTIONS.has(raw.action)) return null;
  if (raw.expectedDigest !== undefined && (typeof raw.expectedDigest !== "string" || !DIGEST.test(raw.expectedDigest))) {
    return null;
  }
  const curated      = {
    requestId: raw.requestId,
    taskId: raw.taskId,
    action: raw.action,
    expectedDigest: raw.expectedDigest === undefined ? null : raw.expectedDigest,
  };
  if (raw.action === "set_page") {
    if (!Object.hasOwn(raw, "monitorUrl")) return null;
    const url = raw.monitorUrl;
    if (url !== null && url !== "" && (typeof url !== "string" || !MONITOR_URL.test(url))) return null;
    curated.monitorUrl = url || null;
  }
  if (USES_ACTIONS.has(raw.action)) {
    const useKey = raw.useKey;
    if (typeof useKey !== "string" || !useKey || useKey.length > USE_KEY_MAX || /[\u0000-\u001f\u007f]/.test(useKey)) return null;
    curated.useKey = useKey;
  }
  return curated;
}

function taskPageReply(requestId        , outcome     )      {
  const out      = { requestId, tasks: [] };
  const listed = record(outcome) ? outcome.list : null;
  if (record(listed) && listed.status === "accepted" && Array.isArray(listed.tasks)) {
    out.tasks = listed.tasks.slice(0, TASKS_MAX);
  } else if (record(listed) && typeof listed.code === "string" && CODE.test(listed.code)) {
    out.code = listed.code;
  }
  const page = record(outcome) ? outcome.page : null;
  if (record(page) && page.status === "accepted" && record(page.page)) out.page = page.page;
  else if (record(page) && typeof page.code === "string" && CODE.test(page.code)) out.code = page.code;
  const act = record(outcome) ? outcome.act : null;
  if (record(act) && ACTIONS.has(act.action)) {
    out.act = {
      action: act.action,
      status: act.status === "done" ? "done" : "rejected",
      ...(act.status !== "done" ? { code: typeof act.code === "string" && CODE.test(act.code) ? act.code : "task_page_failed" } : {}),
    };
  }
  return out;
}

function formatTaskPage(reply     )         {
  return JSON.stringify({ type: TASK_PAGE_FRAME, v: TASK_PAGE_VERSION, ...reply });
}

async function readRecentTaskResultHistory(link     , jobId     , logger      = null)               {
  if (!link || typeof link.request !== "function" || typeof jobId !== "string" || !jobId) return { available: false, results: [] };
  try {
    const reply      = await link.request(LINK_TASK_RESULT_RECENT_METHOD, { jobId });
    if (record(reply) && reply.ok === true && Array.isArray(reply.results)) return { available: true, results: reply.results };
    if (logger && typeof logger.warn === "function") {
      logger.warn(`[hermes-task-page] recent read refused: ${(record(reply) && reply.error) || "unknown"}`);
    }
  } catch (err     ) {
    if (logger && typeof logger.warn === "function") {
      logger.warn(`[hermes-task-page] recent read failed: ${err && err.message ? err.message : err}`);
    }
  }
  return { available: false, results: [] };
}

async function readRecentTaskResults(link     , jobId     , logger      = null)                 {
  return (await readRecentTaskResultHistory(link, jobId, logger)).results;
}

module.exports = { TASK_PAGE_GET_FRAME, TASK_PAGE_ACT_FRAME, TASK_PAGE_FRAME, TASK_PAGE_VERSION, LINK_TASK_RESULT_RECENT_METHOD, taskPageGet, taskPageAct, taskPageReply, formatTaskPage, readRecentTaskResultHistory, readRecentTaskResults };
