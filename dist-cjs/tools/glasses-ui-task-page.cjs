const { isTaskMonitorUrl, keepsSchedules, taskLookTemplateId, taskMonitorRefusal } = require("./glasses-ui-task-schedule.cjs");
const { taskUsesForPhone } = require("./glasses-ui-task-uses.cjs");
const { taskFitForPhone } = require("./glasses-ui-task-fit-records.cjs");

const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESULT_ID_RE = /^[A-Za-z0-9_-]{22}$/;

const TASK_PAGE_RESULTS_MAX = 30;
const HEADLINE_MAX = 200;
const ERROR_MAX = 300;
const REQUEST_MAX = 4000;
const DATE_MAX_MS = 8_640_000_000_000_000;
const TASK_PAGE_ACTIONS = [
  "pause", "resume", "delete", "review_starter", "approve_draft", "keep_current", "set_page",

  "sync",

  "uses_remove", "uses_allow", "uses_keep_off",

  "uses_mark_read", "uses_mark_change",
];
const USES_ACTIONS = new Set(["uses_remove", "uses_allow", "uses_keep_off", "uses_mark_read", "uses_mark_change"]);

function rejected(code     , message     ) {
  return { status: "rejected", code, message };
}

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const stamp = (v     ) => Number.isSafeInteger(v) && v >= 0;

function oneLine(value     , limit        ) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!text) return null;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function taskPageResult(raw     )      {
  if (!record(raw) || !RESULT_ID_RE.test(raw.resultId || "")) return null;
  if (raw.status !== "ok" && raw.status !== "failed") return null;
  if (!stamp(raw.createdAtMs)) return null;
  const headline = oneLine(raw.headline, HEADLINE_MAX);
  if (!headline) return null;
  const error = raw.status === "failed" ? oneLine(raw.error, ERROR_MAX) : null;

  const acked = raw.status === "ok" && stamp(raw.ackedAtMs) && raw.ackedAtMs >= raw.createdAtMs && raw.ackedAtMs <= DATE_MAX_MS;
  return { resultId: raw.resultId, status: raw.status, headline, ...(error ? { error } : {}), createdAtMs: raw.createdAtMs,
    ...(acked ? { ackedAtMs: raw.ackedAtMs } : {}) };
}

function completionTime(raw     )                {
  if (typeof raw !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!match || +match[4] > 23 || +match[5] > 59 || +match[6] > 59) return null;
  const calendar = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== raw.slice(0, 10)) return null;
  const ms = Date.parse(raw);
  return stamp(ms) && ms <= DATE_MAX_MS ? ms : null;
}

function runFacts(job     ) {

  const status = job.lastStatus;
  const lastStatus = status === "ok" || status === "delivery_failed" || status === "delivery_queued" ? status
    : status === "error" || status === "failed" || status === "blocked_config" ? "failed"
    : status == null || status === "" ? null : "unknown";
  return { available: true, running: job.state === "running", lastRunAtMs: completionTime(job.lastRunAt), lastStatus };
}

const unavailableRun = () => ({ available: false, running: false, lastRunAtMs: null, lastStatus: null });

function pageCheck(job     ) {
  const checkedAtMs = completionTime(job.lastCheckAt);
  const error = typeof job.checkError === "string" ? oneLine(job.checkError, ERROR_MAX) || null : null;
  return checkedAtMs === null && error === null ? null : { checkedAtMs, error };
}

function lookOf(plan     ) {
  const templateId = taskLookTemplateId(plan);
  if (templateId === null) return { kind: "agent" };
  return typeof templateId === "string" && TASK_ID_RE.test(templateId) ? { kind: "template", templateId } : null;
}

function createLiveuiTaskPage(deps      = {}) {
  const enabled = typeof deps.enabled === "function" ? deps.enabled : () => false;

  function off() {
    return rejected("scheduled_tasks_off", "Scheduled Tasks are not turned on in the OcuClaw app");
  }

  function readTask(taskId     ) {
    try {
      const loaded      = deps.readTask(taskId);
      return loaded && loaded.status === "accepted" ? loaded.task : null;
    } catch (_) {
      return null;
    }
  }

  function usesOf(taskId        ) {
    if (!deps.uses || typeof deps.uses.read !== "function") return null;
    try {
      return deps.uses.read(taskId);
    } catch (_) {
      return null;
    }
  }

  function fitOf(taskId        ) {
    if (!deps.fits || typeof deps.fits.read !== "function") return {};
    try {
      const fit = taskFitForPhone(deps.fits.read(taskId));
      return fit ? { fit } : {};
    } catch (_) {
      return {};
    }
  }

  function runsWeekOf(taskId        , scheduled         ) {
    if (!deps.runs || typeof deps.runs.week !== "function") return {};
    try {
      const runsWeek = deps.runs.week(taskId, { scheduled });
      return runsWeek ? { runsWeek } : {};
    } catch (_) {
      return {};
    }
  }

  function starterCardOf(plan     , approved     , open         ) {
    if (!open || typeof deps.starterCard !== "function" || !record(plan.starter) || !record(approved)) return {};
    try {
      const card = deps.starterCard(plan.starter.key, approved.request);
      return record(card) ? { starterCard: card } : {};
    } catch (_) {
      return {};
    }
  }

  function nameOf(task     ) {
    const version = task && task.versions && (task.versions.approved || task.versions.pending);
    return oneLine((version && version.name) || (task && task.name), 120) || (task && task.taskId) || "";
  }

  function list() {
    if (!enabled()) return off();
    const scheduler = deps.scheduler();
    if (!keepsSchedules(scheduler)) return { status: "accepted", tasks: [] };
    const tasks        = [];
    for (const row of scheduler.listForGlasses()) {
      const task = readTask(row.taskId);
      if (!task) continue;
      tasks.push({
        taskId: row.taskId,
        name: nameOf(task),
        kind: row.kind,
        when: row.when === undefined ? null : row.when,
        state: row.state,
        jobId: row.jobId || null,
        monitorUrl: isTaskMonitorUrl(row.monitorUrl) ? row.monitorUrl : null,

        starterKey: typeof row.starterKey === "string" ? row.starterKey : null,

        ...(deps.uses ? { needsOk: usesOf(row.taskId)?.needs.length || 0 } : {}),
      });
    }
    return { status: "accepted", tasks };
  }

  async function results(jobId     ) {
    const unavailable = { available: false, results: [] };
    if (!jobId || typeof deps.recentResults !== "function") return unavailable;
    try {
      const raw      = await deps.recentResults(jobId);

      const rows = Array.isArray(raw) ? raw : record(raw) && raw.available === true && Array.isArray(raw.results) ? raw.results : null;
      return rows ? { available: true, results: rows.map(taskPageResult).filter(Boolean).slice(0, TASK_PAGE_RESULTS_MAX) } : unavailable;
    } catch (_) {
      return unavailable;
    }
  }

  async function run(scheduler     , taskId        , jobId               ) {
    const unavailable = { facts: unavailableRun(), historyAllowed: !!jobId, state: null };
    if (!jobId || typeof scheduler.status !== "function") return unavailable;

    const refused = { facts: unavailableRun(), historyAllowed: false, state: null };
    try {

      const reply      = await scheduler.status(taskId);
      if (!reply || reply.status !== "accepted") return refused;
      const state = ["active", "paused", "job_missing"].includes(reply.state) ? reply.state : null;
      if (state === "job_missing") return { facts: unavailableRun(), historyAllowed: false, state };
      const job = reply.job;
      if (!record(job)) return { ...refused, state };
      if (job.id !== jobId || job.taskId !== taskId) return { facts: unavailableRun(), historyAllowed: false, state };
      if (!("lastRunAt" in job) || !("lastStatus" in job)) return { ...unavailable, state, check: pageCheck(job) };
      return { facts: runFacts(job), historyAllowed: true, state, check: pageCheck(job) };
    } catch (_) {
      return refused;
    }
  }

  async function page(taskId     ) {
    if (!enabled()) return off();
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return rejected("task_not_found", "no such Task");
    const scheduler = deps.scheduler();
    if (!keepsSchedules(scheduler)) return rejected("task_schedule_unsupported", "needs a host that keeps schedules");
    const task = readTask(taskId);
    if (!task) return rejected("task_not_found", "no such Task");

    if (typeof scheduler.retrySync === "function") {
      try {
        await scheduler.retrySync(taskId);
      } catch (_) {

      }
    }
    const read      = scheduler.read(taskId);
    const schedule = read && read.status === "accepted" ? read.schedule : null;
    const plan = schedule && schedule.approved;
    if (!plan) return rejected("task_schedule_none", "This Task has no schedule");
    const jobId = schedule.job && schedule.job.state !== "gone" ? schedule.job.jobId : null;
    const pending = task.versions && task.versions.pending;
    const approved = task.versions && task.versions.approved;
    const latestRun = await run(scheduler, taskId, jobId);
    const history = await results(latestRun.historyAllowed ? jobId : null);
    const change      = pending ? { changed: false } : await scheduler.starterChange(taskId);
    return {
      status: "accepted",
      page: {
        taskId,
        name: nameOf(task),
        kind: plan.kind,
        when: plan.when === undefined ? null : plan.when,
        popUp: plan.popUp !== false,
        look: lookOf(plan),

        monitorUrl: isTaskMonitorUrl(plan.monitorUrl) ? plan.monitorUrl : null,

        pageCheck: isTaskMonitorUrl(plan.monitorUrl) ? latestRun.check || null : null,
        state: latestRun.state || schedule.state,
        jobId,
        starterKey: plan.starter && typeof plan.starter.key === "string" ? plan.starter.key : null,
        starterChanged: change.changed === true,

        ...starterCardOf(plan, approved, !pending && change.changed !== true),
        digest: task.digest,
        draft: pending && approved
          ? {
            request: String(pending.request || "").slice(0, REQUEST_MAX),
            approvedRequest: String(approved.request || "").slice(0, REQUEST_MAX),

            ...(!schedule.pending && plan.when ? { keepsWhen: true } : {}),
          }
          : null,
        run: latestRun.facts,

        ...(schedule.state === "unsynced" && typeof scheduler.syncOf === "function"
          ? { sync: scheduler.syncOf(taskId) }
          : {}),
        resultsAvailable: history.available,
        results: history.results,

        ...(deps.uses ? { uses: taskUsesForPhone(usesOf(taskId)) } : {}),

        ...fitOf(taskId),

        ...runsWeekOf(taskId, !!plan.when),
      },
    };
  }

  function actOnUses(taskId        , action        , input     ) {
    const store = deps.uses;
    if (!store) return rejected("task_uses_unsupported", "this host keeps no list");
    const key = record(input) && typeof input.useKey === "string" ? input.useKey : null;
    if (!key) return rejected("task_page_action_invalid", "no step named");
    const outcome = action === "uses_remove" ? store.remove(taskId, key)
      : action === "uses_allow" ? store.allowNeeds(taskId, key)
        : action === "uses_mark_read" || action === "uses_mark_change"
          ? typeof store.markEntry === "function" ? store.markEntry(taskId, key, action === "uses_mark_change") : null
        : store.keepOffNeeds(taskId, key);
    if (!outcome) return rejected("task_uses_save_failed", "the list could not be saved");
    if (outcome.status === "missing") return rejected("task_use_missing", "no such step");
    return { status: "saved" };
  }

  function digestOf(taskId        ) {
    const task = readTask(taskId);
    return task ? task.digest : null;
  }

  async function setPage(scheduler     , taskId        , task     , digest        , input     ) {
    const raw = record(input) ? input.monitorUrl : undefined;
    const read      = scheduler.read(taskId);
    const approved = read && read.status === "accepted" && read.schedule ? read.schedule.approved : null;
    if (!approved || !approved.when) return rejected("task_schedule_none", "A page is checked only on a When");
    const url = raw === null || raw === undefined || raw === "" ? null : raw;
    if (url !== null && !isTaskMonitorUrl(url)) {
      return rejected("task_monitor_invalid", "monitorUrl must be an http(s) URL");
    }
    if (url !== null && approved.kind === "reminder") {
      return rejected("task_monitor_invalid", "A reminder runs with no model call, so it watches no page");
    }
    if ((isTaskMonitorUrl(approved.monitorUrl) ? approved.monitorUrl : null) === url) return { status: "unchanged" };

    const monitorRefused = url !== null ? taskMonitorRefusal(scheduler, { ...approved, monitorUrl: url }) : null;
    if (monitorRefused) return monitorRefused;
    if (task.versions && task.versions.pending) {
      return rejected("task_draft_pending", "Approve or keep the pending Draft first");
    }
    if (typeof deps.approveTask !== "function") return rejected("task_page_failed", "cannot approve here");
    const { monitorUrl: _previous, ...rest } = approved;
    const plan = { ...rest, ...(url ? { monitorUrl: url } : {}) };
    const proposed      = scheduler.propose(taskId, plan, { expectedDigest: digest, authoredBy: "phone" });
    if (!proposed || proposed.status !== "saved") return proposed;
    if (proposed.applied === "draft") {
      let approval     ;
      try {
        approval = await deps.approveTask(taskId, digestOf(taskId));
      } catch (_) {
        approval = null;
      }
      if (!approval || approval.status !== "saved") {
        const draftDigest = digestOf(taskId);
        if (draftDigest && typeof deps.rejectTask === "function") {
          try {
            deps.rejectTask(taskId, draftDigest);
          } catch (_) {

          }
        }
        return approval || rejected("task_review_failed", "not approved");
      }
    }
    const synced      = await scheduler.reconcile(taskId);
    return synced && synced.status === "rejected" ? synced : { status: "saved" };
  }

  async function act(taskId     , action     , expectedDigest      = null, input      = {}) {
    if (!enabled()) return off();
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return rejected("task_not_found", "no such Task");
    if (!TASK_PAGE_ACTIONS.includes(action)) return rejected("task_page_action_invalid", "unknown action");
    const scheduler = deps.scheduler();
    if (!keepsSchedules(scheduler)) return rejected("task_schedule_unsupported", "needs a host that keeps schedules");
    const task = readTask(taskId);
    if (!task) return rejected("task_not_found", "no such Task");
    const digest = typeof expectedDigest === "string" && expectedDigest ? expectedDigest : task.digest;
    let outcome     ;
    if (action === "pause") outcome = await scheduler.pause(taskId);
    else if (action === "resume") outcome = await scheduler.resume(taskId);
    else if (action === "delete") outcome = await deps.deleteTask(taskId, { expectedDigest: digest });
    else if (action === "review_starter") outcome = await scheduler.reviewStarterChange(taskId, { expectedDigest: digest });
    else if (action === "set_page") outcome = await setPage(scheduler, taskId, task, digest, input);
    else if (USES_ACTIONS.has(action)) outcome = actOnUses(taskId, action, input);
    else if (action === "sync") {
      outcome = typeof scheduler.syncAgain === "function"
        ? await scheduler.syncAgain(taskId)
        : rejected("task_page_action_invalid", "this host cannot sync a Task again");
    }
    else {
      outcome = await deps.reviewTask({
        taskId,
        action: action === "approve_draft" ? "approve" : "reject",
        expectedDigest: digest,
      });
    }
    const ok = !!outcome && ["accepted", "saved", "deleted", "unchanged"].includes(outcome.status);
    return ok
      ? { status: "done", action }
      : { status: "rejected", action, code: (outcome && typeof outcome.code === "string" && outcome.code) || "task_page_failed" };
  }

  return { list, page, act };
}

module.exports = { TASK_PAGE_RESULTS_MAX, TASK_PAGE_ACTIONS, taskPageResult, createLiveuiTaskPage };
