const { OpenClawManagementError } = require("./openclaw-management/shared.cjs");
const { pageWatchScript, pageWatchUrlOf } = require("./openclaw-page-watch.cjs");
const { scheduleText, zonedMs } = require("./openclaw-management/jobs.cjs");
const { taskWindowHours, validateTaskWhen } = require("../tools/glasses-ui-task-schedule.cjs");
const { openCardTaskRunPrompt, taskRunPrompt } = require("./openclaw-task-prompt.cjs");
const { StarterRefusal, fillOpenClawStarter } = require("./openclaw-task-starters.cjs");

const OPENCLAW_TASK_OWNER_PREFIX = "ocuclaw-task:";

const OPENCLAW_TASK_DELIVER = "ocuclaw";

const OPENCLAW_TASK_SCHEDULE_METHODS = ["cron.add", "cron.update", "cron.remove", "cron.run", "cron.runs",
  "cron.get", "cron.list"];

const OPERATIONS = new Set([
  "taskSchedule.fillStarter", "taskSchedule.create", "taskSchedule.update", "taskSchedule.pause",
  "taskSchedule.resume", "taskSchedule.run", "taskSchedule.delete", "taskSchedule.status",
  "taskSchedule.foreign", "taskSchedule.adopt",

  "taskSchedule.test", "taskSchedule.testEnd",
]);
const READS = new Set(["taskSchedule.fillStarter", "taskSchedule.status", "taskSchedule.foreign"]);
const KINDS = new Set(["brief", "reminder", "alert"]);
const CRON_DOW      = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const INPUT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const INPUT_TYPES = new Set(["number", "text", "bool", "list", "image"]);
const LIST_PAGE = 200;
const LIST_PAGES_MAX = 5;

const MONITOR_URL_RE = /^https?:\/\/[!-~]{1,490}$/;

const TRIGGERS_OFF_RE = /cron triggers are disabled/i;

const STATUS_SETTLE_MS = 3000;

const OPENCLAW_TEST_STALE_MS = 30 * 60 * 1000;

const TEST_EVERY_MS = 24 * 60 * 60 * 1000;

const MESSAGES      = {
  invalid_request: "Invalid Task schedule request.",
  unsupported: "This OpenClaw host cannot schedule Tasks. Update OpenClaw and OcuClaw.",
  profile_not_served: "That OpenClaw agent is not served here.",
  job_missing: "The Task's scheduled job no longer exists in OpenClaw.",
  job_not_owned: "That OpenClaw job is not owned by this Task.",
  job_owned: "That OpenClaw job already belongs to a Task.",
  job_no_prompt: "That OpenClaw job has no prompt to make a Task from.",
  job_paused: "The Task's schedule is paused. Resume it before running it now.",
  already_running: "The Task is running now. Its result comes when this run ends.",
  run_not_started: "OpenClaw did not start the run. Try again later.",
  starter_missing: "This Starter is not offered by OpenClaw.",
  starter_invalid: "The Starter's blanks are not filled in correctly.",
  starter_changed: "This Starter changed since the Task was approved. Review it as a Draft.",
  schedule_invalid: "OpenClaw could not schedule this time.",
  page_watch_off: "Page watching is off on this OpenClaw. Turn on cron.triggers.enabled.",
  page_watch_once: "OpenClaw checks a page only on a When that repeats.",
  outcome_unknown: "Outcome unknown. Check the Task's schedule status; do not repeat this action.",
  native_failed: "OpenClaw could not read the Task's scheduled job.",
};

const RUN_REFUSALS                         = {
  "already-running": "already_running",
  disabled: "job_paused",
  "invalid-spec": "schedule_invalid",
};

class Refusal extends Error {
  code        ;
  extra     ;

  constructor(code        , extra      = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const printable = (value     , max        ) =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

function fillStarter(starter     ) {
  try {
    return fillOpenClawStarter(starter);
  } catch (error) {
    if (error instanceof StarterRefusal) throw new Refusal(error.code);
    throw error;
  }
}

function text(value     , max = 160) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max) : "";
}

function finite(value     ) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(ms     ) {
  return finite(ms) === null ? "" : new Date(ms).toISOString();
}

function ownerMarker(taskId        ) {
  return `${OPENCLAW_TASK_OWNER_PREFIX}${taskId}`;
}

function markOf(job     )                {
  const description = isPlainObject(job) && typeof job.description === "string" ? job.description.trim() : "";
  if (!description.startsWith(OPENCLAW_TASK_OWNER_PREFIX)) return null;
  const id = description.slice(OPENCLAW_TASK_OWNER_PREFIX.length);
  return TASK_ID_RE.test(id) ? id : null;
}

function isTestTaskId(id     ) {
  return typeof id === "string" && id.startsWith("test-");
}

function taskIdOfJob(job     )                {
  const id = markOf(job);
  return id && !isTestTaskId(id) ? id : null;
}

function testIdOfJob(job     )                {
  const id = markOf(job);
  return id && isTestTaskId(id) ? id : null;
}

function agentOf(job     ) {
  return text(job?.effectiveAgentId, 128) || text(job?.agentId, 128);
}

function ownedBy(job     , taskId        , profileId        ) {
  if (taskIdOfJob(job) !== taskId) return false;
  const agent = agentOf(job);
  return !agent || agent === profileId;
}

function validLookInput(entry     ) {
  if (!isPlainObject(entry) || !INPUT_KEY_RE.test(entry.key || "") || !INPUT_TYPES.has(entry.type)) return false;
  if (entry.label !== undefined && entry.label !== null && !printable(entry.label, 64)) return false;
  for (const bound of ["min", "max"]) {
    const value = entry[bound];
    if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) return false;
  }
  if (entry.fields !== undefined) {
    if (!isPlainObject(entry.fields)) return false;
    const names = Object.keys(entry.fields);
    if (names.length < 1 || names.length > 16) return false;
    if (names.some((name) => !INPUT_KEY_RE.test(name) || !["number", "text", "bool", "image"].includes(entry.fields[name]))) {
      return false;
    }
  }
  return true;
}

function validLook(look     ) {
  if (!isPlainObject(look) || Object.keys(look).sort().join(",") !== "inputs,name") return false;
  if (!printable(look.name, 120) || !look.name.trim()) return false;
  if (!Array.isArray(look.inputs) || look.inputs.length < 1 || look.inputs.length > 16) return false;
  if (!look.inputs.every(validLookInput)) return false;
  return new Set(look.inputs.map((entry     ) => entry.key)).size === look.inputs.length;
}

const TEST_KEYS = new Set(["taskId", "name", "request", "kind", "starter", "look", "openCard", "cardInputs"]);

function validTest(p     ) {
  if (Object.keys(p).some((key) => !TEST_KEYS.has(key))) throw new Refusal("invalid_request");
  if (!printable(p.name, 120) || !p.name.trim()) throw new Refusal("invalid_request");
  if (typeof p.request !== "string" || !p.request.trim() || p.request.length > 4000) throw new Refusal("invalid_request");

  if (p.kind !== "brief") throw new Refusal("invalid_request");
  if (p.starter !== undefined && p.starter !== null && !isPlainObject(p.starter)) throw new Refusal("invalid_request");
  if (p.look !== undefined && p.look !== null && !validLook(p.look)) throw new Refusal("invalid_request");

  if (p.openCard !== undefined && (p.openCard !== true || (p.look !== undefined && p.look !== null))) {
    throw new Refusal("invalid_request");
  }

  if (p.cardInputs !== undefined &&
      (p.openCard !== true || !validLook({ name: p.name, inputs: p.cardInputs }))) {
    throw new Refusal("invalid_request");
  }
  return p;
}

function validate(operation        , payload     ) {
  const p = isPlainObject(payload) ? payload : null;
  if (!p) throw new Refusal("invalid_request");
  if (operation === "taskSchedule.fillStarter") {
    if (Object.keys(p).join(",") !== "starter" || !isPlainObject(p.starter)) throw new Refusal("invalid_request");
    return p;
  }
  if (operation === "taskSchedule.foreign") {
    if (Object.keys(p).join(",") !== "jobId" || !JOB_ID_RE.test(p.jobId || "")) throw new Refusal("invalid_request");
    return p;
  }
  if (!TASK_ID_RE.test(p.taskId || "")) throw new Refusal("invalid_request");

  if ((operation === "taskSchedule.test" || operation === "taskSchedule.testEnd") !== isTestTaskId(p.taskId)) {
    throw new Refusal("invalid_request");
  }
  if (operation === "taskSchedule.test") return validTest(p);
  if (operation !== "taskSchedule.create" && !JOB_ID_RE.test(p.jobId || "")) throw new Refusal("invalid_request");
  if (operation === "taskSchedule.testEnd") {
    if (Object.keys(p).sort().join(",") !== "jobId,taskId") throw new Refusal("invalid_request");
    return p;
  }
  if (operation === "taskSchedule.create" || operation === "taskSchedule.update") {
    if (!printable(p.name, 120) || !p.name.trim()) throw new Refusal("invalid_request");
    if (typeof p.request !== "string" || !p.request.trim() || p.request.length > 4000) throw new Refusal("invalid_request");
    if (!KINDS.has(p.kind)) throw new Refusal("invalid_request");
    const when      = validateTaskWhen(p.when);
    if (when.status !== "accepted" || when.when === null) throw new Refusal("invalid_request");
    if (p.look !== undefined && p.look !== null && !validLook(p.look)) throw new Refusal("invalid_request");

    if (p.monitorUrl !== undefined && p.monitorUrl !== null &&
        (typeof p.monitorUrl !== "string" || !MONITOR_URL_RE.test(p.monitorUrl) || p.kind === "reminder")) {
      throw new Refusal("invalid_request");
    }
  }
  return p;
}

function openClawScheduleFor(when     ) {
  if (when.type === "interval" && when.window) {

    return { kind: "cron", expr: `0 ${taskWindowHours(when).join(",")} * * ${cronDays(when.window.days)}`, tz: when.timeZone };
  }
  if (when.type === "interval") return { kind: "every", everyMs: when.everyMinutes * 60000 };
  if (when.type === "once") {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(when.at);
    if (!match) throw new Refusal("schedule_invalid");
    const [year, month, day, hour, minute] = match.slice(1).map(Number);
    return { kind: "at", at: new Date(zonedMs(year, month, day, hour, minute, when.timeZone)).toISOString() };
  }
  const [hour, minute] = when.time.split(":").map(Number);
  return { kind: "cron", expr: `${minute} ${hour} * * ${cronDays(when.days)}`, tz: when.timeZone };
}

function cronDays(days       ) {
  return days.length === 7
    ? "*"
    : [...new Set(days.map((day     ) => CRON_DOW[day]))].sort((a     , b     ) => a - b).join(",");
}

function zoneView(when     ) {
  return { requested: when.timeZone, host: when.timeZone, exact: true };
}

function field(job     , key        ) {
  return job?.[key] ?? job?.state?.[key];
}

function doneOnce(job     ) {
  return job?.schedule?.kind === "at" && job.enabled === false && finite(field(job, "lastRunAtMs")) !== null;
}

function watchedUrl(job     ) {
  const url = pageWatchUrlOf(job?.trigger?.script);
  return url && MONITOR_URL_RE.test(url) ? url : null;
}

function jobView(job     , taskId        , zone      = null, triggersOff = false) {
  const enabled = job.enabled !== false;
  const done = doneOnce(job);
  const running = finite(job?.state?.runningAtMs) !== null;
  const lastStatus = text(field(job, "lastRunStatus") ?? field(job, "lastStatus"), 32);
  const view      = {
    id: text(job.id, 128),
    taskId,
    name: text(job.displayName, 120) || text(job.name, 120),
    state: running ? "running" : done ? "completed" : !enabled ? "paused" : "scheduled",
    paused: !enabled && !done,
    schedule: text(scheduleText(job.schedule, job?.schedule?.tz || undefined)),
    nextRunAt: enabled ? iso(field(job, "nextRunAtMs")) : "",
    lastRunAt: iso(field(job, "lastRunAtMs")),
    lastStatus,
    deliver: OPENCLAW_TASK_DELIVER,
    attachToSession: false,
    noModel: job?.payload?.kind === "script",
    monitored: false,
    contextFrom: [],
    scheduleDrift: false,
  };
  const monitorUrl = watchedUrl(job);
  if (monitorUrl) {
    view.monitored = true;
    view.monitorUrl = monitorUrl;

    const check = isPlainObject(job?.state?.triggerState) ? job.state.triggerState : {};
    const checkedAt = text(check.checkedAt, 64) || iso(job?.state?.lastTriggerEvalAtMs);
    if (checkedAt) view.lastCheckAt = checkedAt;

    const checkError = triggersOff ? "page watching is off on this OpenClaw" : text(check.error, 160);
    if (checkError) view.checkError = checkError;
  }
  if (zone) view.timeZone = zone;
  return view;
}

function createOpenClawTaskSchedule(opts      = {}) {
  const ctx = opts.ctx;
  const enabled = typeof opts.enabled === "function" ? opts.enabled : () => false;
  const getAgents = typeof opts.getAgents === "function" ? opts.getAgents : async () => [];
  const prompt = typeof opts.prompt === "function" ? opts.prompt : taskRunPrompt;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const notify = (name        , ...args       ) => {
    try {
      if (typeof opts[name] === "function") opts[name](...args);
    } catch (_) {

    }
  };

  const linksOf = (jobId        , profileId        , starter     ) => {
    try {
      const ids = typeof opts.contextFrom === "function" ? opts.contextFrom(jobId, profileId, starter) : [];
      return Array.isArray(ids) ? ids.filter((id     ) => typeof id === "string" && JOB_ID_RE.test(id)).slice(0, 16) : [];
    } catch (_) {
      return [];
    }
  };

  let cronEnabled                 = null;

  let triggersEnabled                 = null;
  let statusKnown = false;
  let statusRead                       = null;

  function methodsReady() {
    return !!ctx && ctx.connected() === true && ctx.advertisesAll(...OPENCLAW_TASK_SCHEDULE_METHODS);
  }

  function readCronStatus() {
    if (statusRead || !ctx || !ctx.advertises("cron.status")) return;
    statusRead = Promise.resolve()
      .then(() => ctx.call("cron.status", {}))
      .then((status     ) => {
        if (status && typeof status.enabled === "boolean") cronEnabled = status.enabled;
        triggersEnabled = status && typeof status.triggersEnabled === "boolean" ? status.triggersEnabled : null;
        statusKnown = true;
      })
      .catch(() => {})
      .finally(() => {
        statusRead = null;
      });
  }

  function available() {
    if (enabled() !== true || !methodsReady()) return false;
    if (cronEnabled === null || !statusKnown) readCronStatus();
    return cronEnabled !== false;
  }

  function pageWatchAvailable() {
    return available() && triggersEnabled === true;
  }

  async function settle() {
    available();
    if (!statusRead) return;
    let timer      = null;
    await Promise.race([statusRead, new Promise      ((done) => { timer = setTimeout(done, STATUS_SETTLE_MS); })]);
    clearTimeout(timer);
  }

  function viewOf(job     , taskId        , zone      = null) {
    return jobView(job, taskId, zone, triggersEnabled === false);
  }

  async function served(profileId        ) {
    const rows = await getAgents();
    return Array.isArray(rows) && rows.some((row     ) => row && row.id === profileId);
  }

  async function call(method        , params     , operation        ) {
    try {
      return await ctx.call(method, params);
    } catch (error     ) {
      if (!(error instanceof OpenClawManagementError)) throw error;
      if (error.code === "unsupported") throw new Refusal("unsupported");

      if (error.hostCode === "INVALID_REQUEST" && (method === "cron.add" || method === "cron.update")) {

        if (TRIGGERS_OFF_RE.test(String(error.hostMessage || error.message || ""))) {
          triggersEnabled = false;
          throw new Refusal("page_watch_off");
        }
        throw new Refusal("schedule_invalid");
      }
      throw new Refusal(READS.has(operation) ? "native_failed" : "outcome_unknown");
    }
  }

  async function readJob(jobId        , operation        ) {
    try {
      const job      = await ctx.call("cron.get", { id: jobId });
      return isPlainObject(job) && job.id === jobId ? job : null;
    } catch (error     ) {
      if (error instanceof OpenClawManagementError && error.hostCode === "INVALID_REQUEST") return null;
      if (error instanceof OpenClawManagementError && error.code === "unsupported") throw new Refusal("unsupported");
      throw new Refusal(READS.has(operation) ? "native_failed" : "outcome_unknown");
    }
  }

  async function ownedJob(p     , profileId        , operation        ) {
    const job = await readJob(p.jobId, operation);
    if (!job) throw new Refusal("job_missing");
    if (!ownedBy(job, p.taskId, profileId)) throw new Refusal("job_not_owned");
    return job;
  }

  async function listJobs(profileId        , operation        ) {
    const jobs        = [];
    for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
      const reply      = await call("cron.list", {
        includeDisabled: true, agentId: profileId, limit: LIST_PAGE, offset: page * LIST_PAGE,
        includeDeliveryPreviews: false,
      }, operation);
      const rows = Array.isArray(reply?.jobs) ? reply.jobs : [];
      jobs.push(...rows);
      if (reply?.hasMore !== true || rows.length === 0) break;
    }
    return jobs;
  }

  function definition(p     , profileId        ) {
    if (p.starter) {

      const starterPrompt = fillStarter(p.starter).prompt;
      if (starterPrompt.trim() !== p.request.trim()) throw new Refusal("starter_changed", { starterPrompt });
    }
    const schedule = openClawScheduleFor(p.when);

    const monitorUrl = typeof p.monitorUrl === "string" && p.monitorUrl ? p.monitorUrl : null;
    if (monitorUrl) {
      if (schedule.kind === "at") throw new Refusal("page_watch_once");
      if (triggersEnabled === false) throw new Refusal("page_watch_off");
    }
    return {
      name: p.name.trim(),
      description: ownerMarker(p.taskId),
      agentId: profileId,
      enabled: true,
      schedule,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: prompt(p.request, p.look || null) },
      delivery: { mode: "none" },

      failureAlert: false,

      ...(schedule.kind === "at" ? { deleteAfterRun: false } : {}),
      ...(monitorUrl ? { trigger: { script: pageWatchScript(monitorUrl) } } : {}),
    };
  }

  async function create(p     , profileId        ) {

    const replaces = JOB_ID_RE.test(p.replacesJobId || "") ? p.replacesJobId : null;
    const { replacesJobId: _replaces, ...rest } = p;
    const data = await createJob(rest, profileId, replaces);
    if (replaces && replaces !== data.job.id) await replaceResults(rest.taskId, profileId, replaces, data.job.id);
    return data;
  }

  async function createJob(p     , profileId        , replaces               ) {

    const owned = (await listJobs(profileId, "taskSchedule.create"))
      .find((job     ) => ownedBy(job, p.taskId, profileId) && job.id !== replaces);
    if (owned && JOB_ID_RE.test(owned.id || "")) return update({ ...p, jobId: owned.id }, profileId, true);
    const params = definition(p, profileId);
    const job      = await call("cron.add", params, "taskSchedule.create");
    const added = isPlainObject(job?.job) ? job.job : job;
    if (!isPlainObject(added) || !JOB_ID_RE.test(added.id || "")) throw new Refusal("outcome_unknown");
    notify("onJobOwned", added.id, p.taskId);
    return { job: viewOf(added, p.taskId, zoneView(p.when)), adopted: false };
  }

  async function replaceResults(taskId        , profileId        , oldId        , newId        ) {
    const old = await readJob(oldId, "taskSchedule.create");
    if (old && !ownedBy(old, taskId, profileId)) return;
    if (old) await call("cron.remove", { id: oldId }, "taskSchedule.create");
    notify("onJobReplaced", oldId, newId);
  }

  async function update(p     , profileId        , adopted = false) {
    const current = await ownedJob(p, profileId, "taskSchedule.update");
    const { agentId: _agent, enabled: _enabled, ...patch }      = definition(p, profileId);

    if (patch.schedule.kind !== "at" && current.deleteAfterRun === true) patch.deleteAfterRun = false;

    if (text(current.displayName)) patch.displayName = null;

    if (!patch.trigger && watchedUrl(current)) patch.trigger = null;
    const job      = await call("cron.update", { id: p.jobId, patch }, "taskSchedule.update");
    const updated = isPlainObject(job) && job.id === p.jobId ? job : { ...current, ...patch };
    return { job: viewOf(updated, p.taskId, zoneView(p.when)), adopted };
  }

  async function status(p     , profileId        ) {
    return { job: viewOf(await ownedJob(p, profileId, "taskSchedule.status"), p.taskId) };
  }

  async function setEnabled(p     , profileId        , on         , operation        ) {
    const current = await ownedJob(p, profileId, operation);

    if (on && doneOnce(current)) throw new Refusal("schedule_invalid");
    const job      = await call("cron.update", { id: p.jobId, patch: { enabled: on } }, operation);
    return { job: viewOf(isPlainObject(job) && job.id === p.jobId ? job : { ...current, enabled: on }, p.taskId) };
  }

  async function runNow(p     , profileId        ) {
    const current = await ownedJob(p, profileId, "taskSchedule.run");

    if (current.enabled === false) throw new Refusal(doneOnce(current) ? "schedule_invalid" : "job_paused");
    const run      = await call("cron.run", { id: p.jobId, mode: "if-enabled" }, "taskSchedule.run");
    if (run && run.ok === false) throw new Refusal("outcome_unknown");

    if (run && run.ran === false) {
      throw new Refusal(Object.hasOwn(RUN_REFUSALS, run.reason) ? RUN_REFUSALS[run.reason] : "run_not_started");
    }
    const after = await readJob(p.jobId, "taskSchedule.run").catch(() => null);
    return { job: viewOf(after || current, p.taskId) };
  }

  async function remove(p     , profileId        ) {
    const job = await readJob(p.jobId, "taskSchedule.delete");
    let data     ;
    if (!job) {
      data = { deleted: false, jobMissing: true };
    } else if (!ownedBy(job, p.taskId, profileId)) {
      throw new Refusal("job_not_owned");
    } else {
      const removed      = await call("cron.remove", { id: p.jobId }, "taskSchedule.delete");
      data = { deleted: removed?.removed !== false, jobMissing: false };
    }

    notify("onJobDeleted", p.jobId);
    return data;
  }

  async function foreignJob(jobId        , profileId        , operation        ) {
    const job = await readJob(jobId, operation);
    if (!job) throw new Refusal("job_missing");
    if (taskIdOfJob(job) !== null) throw new Refusal("job_owned");
    const agent = agentOf(job);
    if (agent && agent !== profileId) throw new Refusal("job_missing");
    return job;
  }

  async function foreign(p     , profileId        ) {
    const job = await foreignJob(p.jobId, profileId, "taskSchedule.foreign");

    const message = job.payload?.kind === "agentTurn" && job.sessionTarget === "isolated" &&
      typeof job.payload.message === "string" ? job.payload.message.trim() : "";
    if (!message) throw new Refusal("job_no_prompt");

    const monitorUrl = watchedUrl(job);
    return { job: { id: text(job.id, 128), name: text(job.displayName) || text(job.name, 120) || text(job.id, 120),
      prompt: message, ...(monitorUrl ? { monitorUrl } : {}) } };
  }

  async function adopt(p     , profileId        ) {
    let job = await readJob(p.jobId, "taskSchedule.adopt");
    if (!job) throw new Refusal("job_missing");
    if (!ownedBy(job, p.taskId, profileId)) {
      job = await foreignJob(p.jobId, profileId, "taskSchedule.adopt");
      const patch = { description: ownerMarker(p.taskId), delivery: { mode: "none" }, failureAlert: false };
      const updated      = await call("cron.update", { id: p.jobId, patch }, "taskSchedule.adopt");
      job = isPlainObject(updated) && updated.id === p.jobId ? updated : { ...job, ...patch };

      notify("onJobOwned", p.jobId, p.taskId);
    }
    return { job: viewOf(job, p.taskId) };
  }

  function staleTest(job     , atMs        ) {
    const made = finite(job?.createdAtMs) ?? finite(job?.updatedAtMs);
    return made === null || atMs - made > OPENCLAW_TEST_STALE_MS;
  }

  async function removeTest(jobId        , operation        ) {
    const removed      = await call("cron.remove", { id: jobId }, operation);
    notify("onTestEnded", jobId);
    return removed?.removed !== false;
  }

  async function sweepTestJobs(profileId        , testTaskId               , operation        ) {
    const atMs = now();
    let removed = 0;
    for (const job of await listJobs(profileId, operation)) {
      const testId = testIdOfJob(job);
      if (!testId || !JOB_ID_RE.test(job.id || "")) continue;
      if (testId !== testTaskId && !staleTest(job, atMs)) continue;
      if (await removeTest(job.id, operation)) removed += 1;
    }
    return removed;
  }

  async function test(p     , profileId        ) {
    await sweepTestJobs(profileId, p.taskId, "taskSchedule.test");
    if (p.starter) {
      const starterPrompt = fillStarter(p.starter).prompt;
      if (starterPrompt.trim() !== p.request.trim()) throw new Refusal("starter_changed", { starterPrompt });
    }

    const pinned = Array.isArray(p.cardInputs) && p.cardInputs.length ? { name: p.name.trim(), inputs: p.cardInputs } : null;
    const message = p.openCard === true && !pinned ? openCardTaskRunPrompt(p.request) : prompt(p.request, pinned || p.look || null);
    const params = {
      name: `Test · ${p.name.trim()}`.slice(0, 120),
      description: ownerMarker(p.taskId),
      agentId: profileId,
      enabled: false,
      schedule: { kind: "every", everyMs: TEST_EVERY_MS },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message },
      delivery: { mode: "none" },
      failureAlert: false,
    };
    const added      = await call("cron.add", params, "taskSchedule.test");
    const job = isPlainObject(added?.job) ? added.job : added;
    if (!isPlainObject(job) || !JOB_ID_RE.test(job.id || "")) throw new Refusal("outcome_unknown");
    let run     ;
    try {
      run = await call("cron.run", { id: job.id, mode: "force" }, "taskSchedule.test");
    } catch (error) {
      await removeTest(job.id, "taskSchedule.test").catch(() => false);
      throw error;
    }
    if ((run && run.ok === false) || (run && run.ran === false)) {

      await removeTest(job.id, "taskSchedule.test").catch(() => false);
      if (run.ok === false) throw new Refusal("outcome_unknown");
      throw new Refusal(Object.hasOwn(RUN_REFUSALS, run.reason) ? RUN_REFUSALS[run.reason] : "run_not_started");
    }
    return { job: { id: job.id, state: "running" } };
  }

  async function testEnd(p     , profileId        ) {
    const job = await readJob(p.jobId, "taskSchedule.testEnd");
    if (!job) {
      notify("onTestEnded", p.jobId);
      return { deleted: false, jobMissing: true };
    }
    const agent = agentOf(job);
    if (testIdOfJob(job) !== p.taskId || (agent && agent !== profileId)) throw new Refusal("job_not_owned");
    return { deleted: await removeTest(p.jobId, "taskSchedule.testEnd"), jobMissing: false };
  }

  async function handle(identity     ) {
    const operation = identity && identity.operation;
    const reply = (fields     ) => ({
      requestId: identity.requestId, operation, scope: identity.scope, profileId: identity.profileId,
      capabilities: [], ...fields,
    });
    const fail = (code        , extra      = null) => reply({
      status: code === "unsupported" ? "unsupported" : "error",
      errorCode: code,
      errorMessage: MESSAGES[code],
      ...(extra && Object.keys(extra).length > 0 ? { taskSchedule: extra } : {}),
    });
    if (!OPERATIONS.has(operation) || identity.scope !== "profile") return fail("invalid_request");
    if (!available()) return fail("unsupported");
    try {
      const p = validate(operation, identity.taskSchedule);
      const profileId = identity.profileId;
      if (!(await served(profileId))) throw new Refusal("profile_not_served");
      let data     ;
      switch (operation) {
        case "taskSchedule.create": data = await create(p, profileId); break;
        case "taskSchedule.update": data = await update(p, profileId); break;
        case "taskSchedule.status": data = await status(p, profileId); break;
        case "taskSchedule.pause": data = await setEnabled(p, profileId, false, operation); break;
        case "taskSchedule.resume": data = await setEnabled(p, profileId, true, operation); break;
        case "taskSchedule.run": data = await runNow(p, profileId); break;
        case "taskSchedule.delete": data = await remove(p, profileId); break;
        case "taskSchedule.fillStarter": data = { starter: fillStarter(p.starter) }; break;
        case "taskSchedule.foreign": data = await foreign(p, profileId); break;
        case "taskSchedule.adopt": data = await adopt(p, profileId); break;
        case "taskSchedule.test": data = await test(p, profileId); break;
        case "taskSchedule.testEnd": data = await testEnd(p, profileId); break;
        default: throw new Refusal("unsupported");
      }
      if (isPlainObject(data.job) && operation !== "taskSchedule.foreign" && operation !== "taskSchedule.test") {
        const starter = operation === "taskSchedule.create" || operation === "taskSchedule.update"
          ? (isPlainObject(p.starter) ? p.starter.key : null) : undefined;
        data.job.contextFrom = linksOf(data.job.id, profileId, starter);
      }
      return reply({ status: "ok", taskSchedule: data });
    } catch (error     ) {
      if (error instanceof Refusal) return fail(error.code, error.extra);
      return fail(READS.has(operation) ? "native_failed" : "outcome_unknown");
    }
  }

  return {
    available,
    pageWatchAvailable,
    settle,
    handle,

    async sweepStaleTests() {
      if (!available()) return 0;
      let removed = 0;
      try {
        for (const row of (await getAgents()) || []) {
          if (row && typeof row.id === "string" && row.id) removed += await sweepTestJobs(row.id, null, "taskSchedule.testEnd");
        }
      } catch (_) {

      }
      return removed;
    },

    noteCronEnabled(value     ) {
      if (typeof value === "boolean") cronEnabled = value;

      statusKnown = false;
      readCronStatus();
    },
  };
}

module.exports = { OPENCLAW_TASK_OWNER_PREFIX, OPENCLAW_TASK_DELIVER, OPENCLAW_TASK_SCHEDULE_METHODS, OPENCLAW_TEST_STALE_MS, ownerMarker, isTestTaskId, taskIdOfJob, testIdOfJob, openClawScheduleFor, createOpenClawTaskSchedule };
