const { taskPushResult } = require("./hermes-task-push.cjs");
const { taskWindowHours } = require("../tools/glasses-ui-task-schedule.cjs");
const { curateJobRun, mergeJobRuns, newestRunAtMs, redactHostText, taskRunFacts, TASK_HOST_ERROR_MAX, TASK_SAME_RUN_MS } = require("../domain/task-run-facts.cjs");

const LINK_TASK_RESULT_LATEST_METHOD = "task.result.latest";
const TASK_ROWS_FRAME = "ocuclaw.task.rows";
const TASK_ROWS_GET_FRAME = "ocuclaw.task.rows.get";
const TASK_ROWS_VERSION = 1;

const TASK_ROWS_MAX = 100;
const LATEST_JOBS_MAX = 50;

const UNDONE_MAX = 50;

const TASK_MISSED_GRACE_MS = 20 * 60_000;

const TASK_MISSED_WINDOW_MS = 7 * 24 * 60 * 60_000;

const TASK_REMINDER_WINDOW_MS = 2 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const KINDS = new Set(["brief", "reminder", "alert"]);
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const ID_MAX = 128;
const NAME_MAX = 200;

const LIBRARY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESULT_ID = /^[A-Za-z0-9_-]{22}$/;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const line = (v     , limit        ) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v);
const stamp = (v     ) => Number.isSafeInteger(v) && v >= 0;

const partsFormat = new Map             ();
function formatter(timeZone        ) {
  let fmt = partsFormat.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    partsFormat.set(timeZone, fmt);
  }
  return fmt;
}

function wallAsUtc(ms        , timeZone        )         {
  const parts      = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) parts[part.type] = part.value;
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
}

function zonedWallToUtcMs(year        , month        , day        , hour        , minute        ,
  timeZone        )         {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offset = wallAsUtc(wall, timeZone) - wall;
  let at = wall - offset;
  const corrected = wallAsUtc(at, timeZone) - at;

  if (corrected !== offset && wallAsUtc(at, timeZone) !== wall) at = wall - corrected;
  return at;
}

function dailyRuns(when     , fromMs        , toMs        )           {
  const [hour, minute] = when.time.split(":").map(Number);
  const start = wallAsUtc(fromMs, when.timeZone) - DAY_MS;
  const runs           = [];
  for (let wall = start; wall <= wallAsUtc(toMs, when.timeZone) + DAY_MS; wall += DAY_MS) {
    const date = new Date(wall);

    if (!when.days.includes(DAYS[(date.getUTCDay() + 6) % 7])) continue;
    const at = zonedWallToUtcMs(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute,
      when.timeZone);
    if (at > fromMs && at <= toMs && runs[runs.length - 1] !== at) runs.push(at);
  }
  return runs;
}

function windowRuns(when     , fromMs        , toMs        )           {
  const runs = new Set        ();
  for (const hour of taskWindowHours(when)) {
    const time = `${String(hour).padStart(2, "0")}:00`;
    for (const at of dailyRuns({ time, days: when.window.days, timeZone: when.timeZone }, fromMs, toMs)) runs.add(at);
  }
  return [...runs].sort((a, b) => a - b);
}

function onceAt(when     )         {
  const [date, time] = when.at.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  return zonedWallToUtcMs(year, month, day, hour, minute, when.timeZone);
}

function nextTaskRunMs(when     , nowMs        , anchorMs                = null)                {
  if (!record(when)) return null;
  try {
    if (when.type === "daily") return dailyRuns(when, nowMs, nowMs + 8 * DAY_MS)[0] ?? null;
    if (when.type === "interval" && record(when.window)) return windowRuns(when, nowMs, nowMs + 8 * DAY_MS)[0] ?? null;
    if (when.type === "once") {
      const at = onceAt(when);
      return at > nowMs ? at : null;
    }
    if (when.type === "interval" && anchorMs !== null) {
      const every = when.everyMinutes * 60_000;
      return anchorMs + (Math.floor(Math.max(0, nowMs - anchorMs) / every) + 1) * every;
    }
  } catch (_) {
    return null;
  }

  return null;
}

function taskPopupUntilMs(result     , schedules       )                {
  if (!result || !stamp(result.createdAtMs) || !Array.isArray(schedules)) return null;
  const schedule = schedules.find(row => row && row.jobId === result.jobId && row.taskId === result.taskId);
  if (!schedule) return null;
  if (schedule.kind === "reminder" || schedule.kind === "alert") {
    const until = result.createdAtMs + TASK_REMINDER_WINDOW_MS;
    return Number.isSafeInteger(until) ? until : null;
  }
  if (schedule.kind === "brief") {
    return nextTaskRunMs(schedule.when, result.createdAtMs, result.createdAtMs);
  }
  return null;
}

function missedTaskRuns(when     , sinceMs        , nowMs        )                                             {
  const none = { count: 0, lastAtMs: null };
  if (!record(when)) return none;
  const from = Math.max(sinceMs, nowMs - TASK_MISSED_WINDOW_MS);
  const to = nowMs - TASK_MISSED_GRACE_MS;
  if (to <= from) return none;
  try {
    if (when.type === "daily" || when.type === "interval" && record(when.window)) {
      const runs = when.type === "daily" ? dailyRuns(when, from, to) : windowRuns(when, from, to);
      return runs.length ? { count: runs.length, lastAtMs: runs[runs.length - 1] } : none;
    }
    if (when.type === "once") {
      const at = onceAt(when);
      return at > from && at <= to ? { count: 1, lastAtMs: at } : none;
    }
    if (when.type === "interval") {
      const every = when.everyMinutes * 60_000;

      const first = sinceMs + every;
      if (first > to) return none;
      const lastAtMs = first + Math.floor((to - first) / every) * every;
      const firstCounted = Math.max(first, first + Math.ceil((from - first) / every) * every);
      if (firstCounted > lastAtMs) return none;
      return { count: Math.floor((lastAtMs - firstCounted) / every) + 1, lastAtMs };
    }
  } catch (_) {
    return none;
  }
  return none;
}

function latestJob(raw     )      {
  if (!record(raw) || !line(raw.jobId, ID_MAX)) return null;
  if (raw.jobName !== null && raw.jobName !== undefined && !line(raw.jobName, NAME_MAX)) return null;
  const latest = raw.latest === null || raw.latest === undefined ? null : taskPushResult(raw.latest);
  if (raw.latest && !latest) return null;
  if (latest && latest.jobId !== raw.jobId) return null;
  const failedAtMs = raw.failedAtMs === null || raw.failedAtMs === undefined ? null : raw.failedAtMs;
  if (failedAtMs !== null && !stamp(failedAtMs)) return null;

  const run = curateJobRun(raw.run);
  if (!latest && failedAtMs === null && !run) return null;
  const failedError = failedAtMs !== null && typeof raw.failedError === "string" && raw.failedError.trim()
    ? redactHostText(raw.failedError.slice(0, TASK_HOST_ERROR_MAX))
    : null;

  const undoneAtMs = Array.isArray(raw.undoneAtMs)
    ? raw.undoneAtMs.slice(-UNDONE_MAX).filter(stamp)
    : [];
  return {
    jobId: raw.jobId,
    jobName: raw.jobName || null,
    latest,
    latestAcked: latest ? raw.latestAcked === true : false,
    latestDone: latest ? raw.latestDone === true : false,
    undoneAtMs,
    failedAtMs,
    failedError,
    run,
  };
}

function jobNewestRunAtMs(job     )                {
  return newestRunAtMs(job.latest ? job.latest.createdAtMs : null, job.failedAtMs, job.run);
}

const TASK_HELD_RUNS_MAX = 64;

function noteHermesHeldRun(held                     , jobId     , atMs     )          {
  if (!(held instanceof Map) || !line(jobId, ID_MAX) || !stamp(atMs)) return false;
  held.delete(jobId);
  held.set(jobId, atMs);
  while (held.size > TASK_HELD_RUNS_MAX) held.delete(held.keys().next().value          );
  return true;
}

function isHeldAnswer(heldAnswers     , resultId     )          {
  if (typeof resultId !== "string") return false;
  if (heldAnswers instanceof Map) return heldAnswers.has(resultId);
  return record(heldAnswers) && Object.hasOwn(heldAnswers, resultId);
}

function withoutHeldLatest(job     , heldAnswers     )      {
  if (!job || !job.latest || !isHeldAnswer(heldAnswers, job.latest.resultId)) return job;
  const hidden = { ...job, latest: null, latestAcked: false, latestDone: false };
  return hidden.failedAtMs === null && !hidden.run ? null : hidden;
}

function withoutHeldAnswers(history     , heldAnswers     )      {
  if (!record(history) || !Array.isArray(history.results)) return history;
  return { ...history, results: history.results.filter((result     ) => !isHeldAnswer(heldAnswers, record(result) ? result.resultId : null)) };
}

function heldJobRun(run     , heldAtMs     )      {
  const last = run && run.lastRun;
  if (!last || last.outcome !== "failed" || !stamp(heldAtMs) || Math.abs(last.endedAtMs - heldAtMs) > TASK_SAME_RUN_MS) return run;
  return { ...run, lastRun: { ...last, held: true } };
}

function rowRun(schedule     , job     , missed     , nowMs        , cardRun      = null, unchecked      = null,
  heldAtMs      = null)      {
  const jobRun = mergeJobRuns(heldJobRun(job ? job.run : null, heldAtMs), cardRun);

  const cardEndedAtMs = cardRun && cardRun.lastRun ? cardRun.lastRun.endedAtMs : null;
  const stillMissed = missed && cardEndedAtMs !== null && missed.lastAtMs !== null && missed.lastAtMs <= cardEndedAtMs
    ? null
    : missed;
  return taskRunFacts({
    scheduleState: schedule ? schedule.state : null,
    sync: schedule ? schedule.sync : null,
    latestAtMs: job && job.latest ? job.latest.createdAtMs : null,
    failedAtMs: job ? job.failedAtMs : null,
    failedError: job ? job.failedError : null,
    jobRun,
    missed: stillMissed,
    unchecked,
    nowMs,
  });
}

function missedReminders(when     , job     , live         , nowMs        )                                             {
  const from = nowMs - TASK_MISSED_WINDOW_MS;
  const to = nowMs - TASK_REMINDER_WINDOW_MS;
  const undone = (job ? job.undoneAtMs : []).filter((at        ) => at > from && at <= to);
  const since = job ? jobNewestRunAtMs(job) : null;
  const scheduled = live && since !== null
    ? missedTaskRuns(when, since, nowMs)
    : { count: 0, lastAtMs: null };
  const count = undone.length + scheduled.count;
  if (count === 0) return { count: 0, lastAtMs: null };
  const lastAtMs = Math.max(0, ...undone, scheduled.lastAtMs ?? 0);
  return { count, lastAtMs };
}

const TASK_LEFT_OUT_MAX = 99;

function leftOutCount(leftOut     , taskId        )         {
  if (!record(leftOut) || !Object.hasOwn(leftOut, taskId)) return 0;
  const count = leftOut[taskId];
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, TASK_LEFT_OUT_MAX) : 0;
}

function buildTaskRows({ schedules, jobs, nowMs, cardRuns = null, uncheckedRuns = null, leftOut = null, heldRuns = null,
  heldAnswers = null }     )        {
  const byJob = new Map             ();
  for (const raw of Array.isArray(jobs) ? jobs.slice(0, LATEST_JOBS_MAX) : []) {
    const job = withoutHeldLatest(latestJob(raw), heldAnswers);
    if (job && !byJob.has(job.jobId)) byJob.set(job.jobId, job);
  }
  const rows        = [];
  const owned = new Set        ();
  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    if (!record(schedule) || !line(schedule.taskId, ID_MAX) || !KINDS.has(schedule.kind)) continue;
    const jobId = line(schedule.jobId, ID_MAX) ? schedule.jobId : null;
    if (jobId) owned.add(jobId);
    const job = jobId ? byJob.get(jobId) || null : null;
    const latest = job ? job.latest : null;

    const since = job ? jobNewestRunAtMs(job) : null;

    const live = schedule.state === "active" && !!jobId && record(schedule.when);

    const missed = schedule.kind === "reminder"
      ? missedReminders(schedule.when, job, live, nowMs)
      : live && since !== null ? missedTaskRuns(schedule.when, since, nowMs) : { count: 0, lastAtMs: null };
    rows.push({
      taskId: schedule.taskId,
      jobId,
      jobName: job ? job.jobName : null,
      kind: schedule.kind,
      nextRunAtMs: live ? nextTaskRunMs(schedule.when, nowMs, since) : null,
      missedCount: missed.count,
      missedLastAtMs: missed.lastAtMs,
      latest,
      latestAcked: job ? job.latestAcked : false,

      latestDone: job ? job.latestDone : false,
      failedAtMs: job ? job.failedAtMs : null,
      run: rowRun(schedule, job, missed, nowMs,
        record(cardRuns) && Object.hasOwn(cardRuns, schedule.taskId) ? curateJobRun(cardRuns[schedule.taskId]) : null,
        record(uncheckedRuns) && Object.hasOwn(uncheckedRuns, schedule.taskId) ? uncheckedRuns[schedule.taskId] : null,
        jobId && record(heldRuns) && Object.hasOwn(heldRuns, jobId) ? heldRuns[jobId] : null),

      ...(schedule.state === "paused" ? { paused: true } : {}),

      ...(schedule.state === "none" ? { ask: true } : {}),

      ...(leftOutCount(leftOut, schedule.taskId) > 0 ? { leftOut: leftOutCount(leftOut, schedule.taskId) } : {}),

      ...(LIBRARY_ID.test(schedule.lookTemplateId || "")
        ? {
          lookTemplateId: schedule.lookTemplateId,
          lookResultId: typeof schedule.lookResultId === "string" && RESULT_ID.test(schedule.lookResultId)
            ? schedule.lookResultId
            : null,
        }
        : {}),
    });
  }
  for (const job of byJob.values()) {

    if (owned.has(job.jobId) || !job.latest) continue;
    rows.push({
      taskId: null,
      jobId: job.jobId,
      jobName: job.jobName,
      kind: null,
      nextRunAtMs: null,
      missedCount: 0,
      missedLastAtMs: null,
      latest: job.latest,
      latestAcked: job.latestAcked,
      failedAtMs: job.failedAtMs,
      run: rowRun(null, job, null, nowMs),
    });
  }
  return rows.slice(0, TASK_ROWS_MAX);
}

function taskJobLastRuns(schedules     , jobs     )        {
  const byJob = new Map             ();
  for (const raw of Array.isArray(jobs) ? jobs.slice(0, LATEST_JOBS_MAX) : []) {
    const job = latestJob(raw);
    if (job && !byJob.has(job.jobId)) byJob.set(job.jobId, job);
  }
  const out        = [];
  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    if (!record(schedule) || !line(schedule.taskId, ID_MAX) || !line(schedule.jobId, ID_MAX)) continue;
    const lastRun = byJob.get(schedule.jobId)?.run?.lastRun;
    if (record(lastRun)) out.push({ taskId: schedule.taskId, lastRun });
  }
  return out;
}

function formatTaskRows(rows       )         {
  return JSON.stringify({ type: TASK_ROWS_FRAME, v: TASK_ROWS_VERSION, rows: rows.slice(0, TASK_ROWS_MAX) });
}

const TASK_ROWS_RING_DELAY_MS = 250;

function createTaskRowsBroadcast({
  read, send, delayMs = TASK_ROWS_RING_DELAY_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, logger,
}     ) {
  let timer      = null;
  let reading = false;
  let again = false;
  let disposed = false;

  function warn(message     ) {
    if (logger && typeof logger.warn === "function") logger.warn(`[task-rows-broadcast] ${message}`);
  }

  async function flush() {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      const rows = typeof read === "function" ? await read() : null;
      if (!disposed && Array.isArray(rows) && typeof send === "function") send(formatTaskRows(rows));
    } catch (err     ) {
      warn(`rows not sent: ${err && err.message ? err.message : err}`);
    } finally {
      reading = false;
    }
    if (again && !disposed) {
      again = false;
      ring();
    }
  }

  function ring() {
    if (disposed || timer !== null) return;
    timer = setTimeoutFn(() => {
      timer = null;
      void flush();
    }, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function dispose() {
    disposed = true;
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  }

  return { ring, flush, dispose };
}

const LINK_TASK_ROWS_CHANGED_METHOD = "task.rows.changed";

const ROWS_WITHOUT_JOBS = new WeakSet        ();

function taskRowsMissJobs(rows     )          {
  return !!rows && typeof rows === "object" && ROWS_WITHOUT_JOBS.has(rows);
}

function createHermesTaskRows({ link, schedules, setLook = null, cardRuns = null, uncheckedRuns = null, leftOut = null,
  heldRuns = null, heldAnswers = null, onJobRuns = null, now = Date.now, logger }     ) {
  function warn(message     ) {
    if (logger && typeof logger.warn === "function") logger.warn(`[hermes-task-rows] ${message}`);
  }

  async function latestJobs()                                            {
    if (!link || typeof link.request !== "function") return { jobs: [], failed: false };
    try {
      const reply      = await link.request(LINK_TASK_RESULT_LATEST_METHOD, {});
      if (record(reply) && reply.ok === true && Array.isArray(reply.jobs)) return { jobs: reply.jobs, failed: false };
      warn(`latest read refused: ${(record(reply) && reply.error) || "unknown"}`);
    } catch (err     ) {
      warn(`latest read failed: ${err && err.message ? err.message : err}`);
    }
    return { jobs: [], failed: true };
  }

  async function read()                 {
    let scheduled        = [];
    try {
      scheduled = typeof schedules === "function" ? schedules() || [] : [];
    } catch (err     ) {
      warn(`schedules read failed: ${err && err.message ? err.message : err}`);
    }
    const { jobs, failed: jobsFailed } = await latestJobs();

    if (typeof onJobRuns === "function") {
      try {
        onJobRuns(taskJobLastRuns(scheduled, jobs));
      } catch (err     ) {
        warn(`run tally failed: ${err && err.message ? err.message : err}`);
      }
    }

    let started      = null;
    try {
      started = typeof cardRuns === "function" ? cardRuns() : null;
    } catch (err     ) {
      warn(`card runs read failed: ${err && err.message ? err.message : err}`);
    }

    let failedChecks      = null;
    try {
      failedChecks = typeof uncheckedRuns === "function" ? uncheckedRuns() : null;
    } catch (err     ) {
      warn(`unchecked runs read failed: ${err && err.message ? err.message : err}`);
    }

    const waiting                         = {};
    if (typeof leftOut === "function") {
      for (const schedule of Array.isArray(scheduled) ? scheduled : []) {
        const taskId = record(schedule) && line(schedule.taskId, ID_MAX) ? schedule.taskId : null;
        if (!taskId || Object.hasOwn(waiting, taskId)) continue;
        try {
          waiting[taskId] = leftOut(taskId);
        } catch (err     ) {
          warn(`left-out read failed: ${err && err.message ? err.message : err}`);
        }
      }
    }

    let held      = null;
    try {
      held = typeof heldRuns === "function" ? heldRuns() : null;
    } catch (err     ) {
      warn(`held runs read failed: ${err && err.message ? err.message : err}`);
    }

    let guessed      = null;
    try {
      guessed = typeof heldAnswers === "function" ? heldAnswers() : null;
    } catch (err     ) {
      warn(`held answers read failed: ${err && err.message ? err.message : err}`);
    }
    const rows = buildTaskRows({ schedules: scheduled, jobs, nowMs: now(), cardRuns: started, uncheckedRuns: failedChecks, leftOut: waiting,
      heldRuns: held, heldAnswers: guessed });
    if (jobsFailed) ROWS_WITHOUT_JOBS.add(rows);
    return rows;
  }

  async function useLook(choice     )                        {
    if (typeof setLook !== "function") return null;
    try {
      const set      = await setLook(choice.taskId, { kind: "template", templateId: choice.templateId });
      if (!set || (set.status !== "saved" && set.status !== "unchanged")) {
        warn(`look for ${choice.taskId} refused: ${(set && set.code) || "unknown"}`);
      }
    } catch (err     ) {
      warn(`look for ${choice.taskId} failed: ${err && err.message ? err.message : err}`);
    }
    return read();
  }

  async function actOnReminder(choice     )                        {
    if (!link || typeof link.request !== "function") return null;
    try {
      const reply      = await link.request(LINK_TASK_RESULT_REMINDER_METHOD, choice);
      if (!record(reply) || reply.ok !== true) {
        warn(`reminder ${choice.action} refused: ${(record(reply) && reply.error) || "unknown"}`);
      }
    } catch (err     ) {
      warn(`reminder ${choice.action} failed: ${err && err.message ? err.message : err}`);
    }
    return read();
  }

  return { read, useLook, actOnReminder };
}

const TASK_REMINDER_FRAME = "ocuclaw.task.reminder";
const LINK_TASK_RESULT_REMINDER_METHOD = "task.result.reminder";
const REMINDER_ACTIONS = new Set(["done", "again"]);

function taskReminderAct(raw     )      {
  if (!record(raw) || raw.type !== TASK_REMINDER_FRAME) return null;
  if (Object.keys(raw).sort().join(",") !== "action,resultId,type") return null;
  if (typeof raw.resultId !== "string" || !RESULT_ID.test(raw.resultId) || !REMINDER_ACTIONS.has(raw.action)) {
    return null;
  }
  return { resultId: raw.resultId, action: raw.action };
}

const TASK_LOOK_OFFER_FRAME = "ocuclaw.task.look.offer";
const TASK_LOOK_SET_FRAME = "ocuclaw.task.look.set";
const TASK_LOOK_VERSION = 1;

function taskLookOffer(raw     )      {
  if (!record(raw) || !LIBRARY_ID.test(raw.taskId || "") || !LIBRARY_ID.test(raw.templateId || "")) return null;
  if (!line(raw.name, NAME_MAX)) return null;
  if (raw.taskName !== undefined && raw.taskName !== null && !line(raw.taskName, NAME_MAX)) return null;
  return {
    taskId: raw.taskId,
    templateId: raw.templateId,
    name: raw.name,
    taskName: typeof raw.taskName === "string" ? raw.taskName : null,
  };
}

function formatTaskLookOffer(offer     )         {
  return JSON.stringify({ type: TASK_LOOK_OFFER_FRAME, v: TASK_LOOK_VERSION, ...offer });
}

function taskLookSet(raw     )      {
  if (!record(raw) || raw.type !== TASK_LOOK_SET_FRAME) return null;
  const keys = Object.keys(raw).sort().join(",");
  if (keys !== "taskId,templateId,type") return null;
  if (!LIBRARY_ID.test(raw.taskId || "") || !LIBRARY_ID.test(raw.templateId || "")) return null;
  return { taskId: raw.taskId, templateId: raw.templateId };
}

module.exports = { LINK_TASK_RESULT_LATEST_METHOD, TASK_ROWS_FRAME, TASK_ROWS_GET_FRAME, TASK_ROWS_VERSION, TASK_ROWS_MAX, TASK_MISSED_GRACE_MS, TASK_MISSED_WINDOW_MS, TASK_REMINDER_WINDOW_MS, zonedWallToUtcMs, nextTaskRunMs, taskPopupUntilMs, missedTaskRuns, TASK_HELD_RUNS_MAX, noteHermesHeldRun, withoutHeldAnswers, missedReminders, TASK_LEFT_OUT_MAX, buildTaskRows, taskJobLastRuns, formatTaskRows, TASK_ROWS_RING_DELAY_MS, createTaskRowsBroadcast, LINK_TASK_ROWS_CHANGED_METHOD, taskRowsMissJobs, createHermesTaskRows, TASK_REMINDER_FRAME, LINK_TASK_RESULT_REMINDER_METHOD, taskReminderAct, TASK_LOOK_OFFER_FRAME, TASK_LOOK_SET_FRAME, TASK_LOOK_VERSION, taskLookOffer, formatTaskLookOffer, taskLookSet };
