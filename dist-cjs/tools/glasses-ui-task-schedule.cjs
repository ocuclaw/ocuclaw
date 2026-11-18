const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, canonicalSerialize, isValidLiveuiLibraryItemId, liveuiLibraryDigest, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { carryUnknownFields, hasUnknownFields, knownFields } = require("./saved-format.cjs");
const { createTaskScheduleTransport } = require("./glasses-ui-task-schedule-transport.cjs");
const { TASK_SYNC_RETRY_EVERY_MS, TASK_SYNC_TRIES_MAX, taskSyncError } = require("../domain/task-run-facts.cjs");
const { TASK_UNCHECKED_PROMPT_CONTRACT } = require("./glasses-ui-task-unchecked.cjs");
const { OCUCLAW_STARTER_LOOKS, ocuclawStarterLookFor } = require("./glasses-ui-template-values.cjs");
const { startsWithHostGlassesRules } = require("./glasses-ui-task-rules.cjs");

const LIVEUI_TASK_SCHEDULE_SCHEMA_VERSION = 1;

const TASK_RULES_ONCE_PROMPT_CONTRACT = 1;

const TASK_HOST_RULES_PROMPT_CONTRACT = 2;
const LIVEUI_TASK_SCHEDULE_DIRNAME = "task-schedules";
const LIVEUI_TASK_KINDS = ["brief", "reminder", "alert"];
const LIVEUI_TASK_WHEN_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const CLOCK_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const LOCAL_AT_RE = /^\d{4}-\d{2}-\d{2}T([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;
const STARTER_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SLOT_NAME_RE = /^[a-z_][a-z0-9_]{0,31}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PLAN_KEYS = new Set(["when", "kind", "starter", "monitorUrl", "popUp", "look"]);

const MONITOR_URL_RE = /^https?:\/\/[!-~]{1,490}$/;
const JOB_STATES = new Set(["active", "paused", "gone"]);

function rejected(code     , message     , extra      = {}) {
  return { status: "rejected", code, message, ...extra };
}

function isTaskMonitorUrl(value     )          {
  return typeof value === "string" && MONITOR_URL_RE.test(value);
}

function taskMonitorNeedsWhen(plan     ) {
  return isPlainObject(plan) && hasOwn(plan, "monitorUrl") && plan.when === null
    ? rejected("task_monitor_needs_when", "A page to watch needs a When: Only when I ask never checks it")
    : null;
}

const hasOwn = (value     , key     ) => Object.prototype.hasOwnProperty.call(value, key);
const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);

function validTimeZone(name     ) {
  if (typeof name !== "string" || !ZONE_RE.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch (_) {
    return false;
  }
}

function validateTaskWindow(input     , everyMinutes        ) {
  if (!isPlainObject(input) || Object.keys(input).sort().join(",") !== "days,fromHour,toHour") return null;
  if (everyMinutes % 60 !== 0) return null;
  const hour = (value     ) => Number.isSafeInteger(value) && value >= 0 && value <= 23;
  if (!hour(input.fromHour) || !hour(input.toHour) || input.toHour < input.fromHour) return null;
  if (!Array.isArray(input.days) || input.days.length < 1 || new Set(input.days).size !== input.days.length ||
      input.days.some((day     ) => !LIVEUI_TASK_WHEN_DAYS.includes(day))) return null;
  return { days: LIVEUI_TASK_WHEN_DAYS.filter((day) => input.days.includes(day)), fromHour: input.fromHour, toHour: input.toHour };
}

function taskWindowHours(when     )           {
  const window = when?.window;
  if (!isPlainObject(window) || !Number.isSafeInteger(when.everyMinutes) || when.everyMinutes < 60) return [];
  const step = Math.floor(when.everyMinutes / 60);
  const hours           = [];
  for (let hour = window.fromHour; hour <= window.toHour; hour += step) hours.push(hour);
  return hours;
}

function validateTaskWhen(input     ) {
  if (input === null) return { status: "accepted", when: null };
  const invalid = rejected("task_when_invalid", "When must be null, daily, interval, or once");
  if (!isPlainObject(input) || !validTimeZone(input.timeZone)) return invalid;
  const keys = Object.keys(input).sort().join(",");
  if (input.type === "daily") {
    if (keys !== "days,time,timeZone,type" || typeof input.time !== "string" || !CLOCK_RE.test(input.time)) {
      return invalid;
    }
    if (!Array.isArray(input.days) || input.days.length < 1 ||
        new Set(input.days).size !== input.days.length ||
        input.days.some((day     ) => !LIVEUI_TASK_WHEN_DAYS.includes(day))) return invalid;
    const days = LIVEUI_TASK_WHEN_DAYS.filter((day) => input.days.includes(day));
    return { status: "accepted", when: { type: "daily", time: input.time, days, timeZone: input.timeZone } };
  }
  if (input.type === "interval") {
    if ((keys !== "everyMinutes,timeZone,type" && keys !== "everyMinutes,timeZone,type,window") ||
        !Number.isSafeInteger(input.everyMinutes) || input.everyMinutes < 15 || input.everyMinutes > 1440) return invalid;
    if (!hasOwn(input, "window")) {
      return { status: "accepted", when: { type: "interval", everyMinutes: input.everyMinutes, timeZone: input.timeZone } };
    }
    const window = validateTaskWindow(input.window, input.everyMinutes);
    if (!window) return invalid;
    return { status: "accepted", when: { type: "interval", everyMinutes: input.everyMinutes, timeZone: input.timeZone, window } };
  }
  if (input.type === "once") {
    if (keys !== "at,timeZone,type" || typeof input.at !== "string" || !LOCAL_AT_RE.test(input.at) ||
        Number.isNaN(Date.parse(`${input.at}:00Z`))) return invalid;
    return { status: "accepted", when: { type: "once", at: input.at, timeZone: input.timeZone } };
  }
  return invalid;
}

function validStarterNote(note     )          {
  if (typeof note !== "string" || !note.trim() || note.length > 500) return false;
  for (const ch of note) {
    const code = ch.codePointAt(0)          ;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return false;
  }
  return true;
}

function validateStarter(input     ) {
  if (input === null || input === undefined) return { status: "accepted", starter: null };
  const invalid = rejected("task_starter_invalid", "starter must be { key, slots, note? }");
  const keys = isPlainObject(input) ? Object.keys(input).sort().join(",") : "";
  if (keys !== "key,slots" && keys !== "key,note,slots") return invalid;

  if (input.note !== undefined && !validStarterNote(input.note)) return invalid;
  if (typeof input.key !== "string" || !STARTER_KEY_RE.test(input.key) || !isPlainObject(input.slots)) return invalid;
  const names = Object.keys(input.slots);
  if (names.length > 16) return invalid;
  const slots      = {};
  for (const name of names.sort()) {
    const value = input.slots[name];
    if (!SLOT_NAME_RE.test(name)) return invalid;
    if (typeof value === "string") {
      if (value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) return invalid;
    } else if (typeof value !== "number" || !Number.isFinite(value)) {
      return invalid;
    }
    slots[name] = value;
  }
  return { status: "accepted", starter: { key: input.key, slots, ...(input.note !== undefined ? { note: input.note } : {}) } };
}

const LIVEUI_TASK_LOOK_KINDS = ["template", "agent"];

function validateLook(input     ) {
  if (input === null || input === undefined) return { status: "accepted", look: null };
  const invalid = rejected("task_look_invalid", "look must be { kind: \"template\", templateId } or { kind: \"agent\" }");
  if (!isPlainObject(input) || !LIVEUI_TASK_LOOK_KINDS.includes(input.kind)) return invalid;
  if (input.kind === "agent") {
    return Object.keys(input).length === 1 ? { status: "accepted", look: { kind: "agent" } } : invalid;
  }
  if (Object.keys(input).sort().join(",") !== "kind,templateId" || !isValidLiveuiLibraryItemId(input.templateId)) {
    return invalid;
  }
  return { status: "accepted", look: { kind: "template", templateId: input.templateId } };
}

function taskLookTemplateId(plan     )                            {
  if (!isPlainObject(plan)) return undefined;
  if (isPlainObject(plan.look)) return plan.look.kind === "template" ? plan.look.templateId : null;
  const key = isPlainObject(plan.starter) ? plan.starter.key : null;
  const row = key ? OCUCLAW_STARTER_LOOKS.find((candidate) => candidate.blueprintKey === key) : null;
  return row ? row.templateId : undefined;
}

function validateTaskSchedulePlan(input     ) {
  if (!isPlainObject(input) || Object.keys(input).some((key) => !PLAN_KEYS.has(key))) {
    return rejected("task_schedule_invalid", "plan must be { when, kind, starter?, monitorUrl?, popUp?, look? }");
  }
  if (hasOwn(input, "popUp") && typeof input.popUp !== "boolean") {
    return rejected("task_schedule_invalid", "popUp must be true or false");
  }
  if (!hasOwn(input, "when")) return rejected("task_when_invalid", "when is required (null means only when asked)");
  const when      = validateTaskWhen(input.when);
  if (when.status !== "accepted") return when;
  if (!LIVEUI_TASK_KINDS.includes(input.kind)) {
    return rejected("task_kind_invalid", "kind must be brief, reminder, or alert");
  }
  const starter      = validateStarter(input.starter);
  if (starter.status !== "accepted") return starter;
  if (hasOwn(input, "monitorUrl") &&
      (typeof input.monitorUrl !== "string" || !MONITOR_URL_RE.test(input.monitorUrl) || input.kind === "reminder")) {

    return rejected("task_monitor_invalid", "monitorUrl must be an http(s) URL, and never on a reminder");
  }
  const look      = validateLook(input.look);
  if (look.status !== "accepted") return look;
  return {
    status: "accepted",
    plan: {
      when: when.when,
      kind: input.kind,
      ...(starter.starter ? { starter: starter.starter } : {}),
      ...(hasOwn(input, "monitorUrl") ? { monitorUrl: input.monitorUrl } : {}),
      ...(input.popUp === false ? { popUp: false } : {}),

      ...(look.look ? { look: look.look } : {}),
    },
  };
}

function taskScheduleBinding(version     ) {
  return {
    taskVersionId: version.versionId,
    requestDigest: liveuiLibraryDigest({ request: version.request, settings: version.settings }),
  };
}

function boundTo(entry     , version     ) {
  if (!entry || !version) return false;
  const binding = taskScheduleBinding(version);
  return entry.taskVersionId === binding.taskVersionId && entry.requestDigest === binding.requestDigest;
}

function isTaskScheduleRelaxation(approved     , next     ) {

  if (isPlainObject(approved) && isPlainObject(next)) {
    const { look: _approvedLook, ...approvedRest } = approved;
    const { look: _nextLook, ...nextRest } = next;
    if (canonicalSerialize(approvedRest) === canonicalSerialize(nextRest)) return true;
  }
  if (!approved || !approved.when || !next) return false;

  if (approved.kind !== next.kind ||
      canonicalSerialize(approved.starter || null) !== canonicalSerialize(next.starter || null) ||
      (approved.monitorUrl || null) !== (next.monitorUrl || null)) return false;
  if (approved.popUp === false && next.popUp !== false) return false;
  if (next.when === null) return true;
  if (approved.when.type !== next.when.type) return false;
  if (next.when.type === "daily") return next.when.days.every((day     ) => approved.when.days.includes(day));
  if (next.when.type === "interval") {
    if (next.when.everyMinutes < approved.when.everyMinutes) return false;

    const was = approved.when.window;
    if (!was) return true;
    const now = next.when.window;
    return !!now && now.days.every((day     ) => was.days.includes(day)) &&
      now.fromHour >= was.fromHour && now.toHour <= was.toHour;
  }
  return true;
}

function keptPlan(plan     , previous     , approved     ) {
  if (!plan.starter || String(previous.request || "").trim() === String(approved.request || "").trim()) return plan;
  const { starter: _starter, ...rest } = plan;
  const card = isPlainObject(plan.look) ? null : taskLookTemplateId(plan);
  return { ...rest, ...(typeof card === "string" ? { look: { kind: "template", templateId: card } } : {}) };
}

function validStoredPlan(entry     ) {
  if (!isPlainObject(entry)) return false;
  if (Object.keys(entry).sort().join(",") !== "authoredBy,plan,requestDigest,taskVersionId") return false;
  if (typeof entry.taskVersionId !== "string" || !/^v[1-9][0-9]*$/.test(entry.taskVersionId)) return false;
  if (typeof entry.requestDigest !== "string" || !entry.requestDigest.startsWith("sha256:")) return false;
  if (!["agent", "phone"].includes(entry.authoredBy)) return false;
  const plan      = validateTaskSchedulePlan(entry.plan);
  return plan.status === "accepted" && canonicalSerialize(plan.plan) === canonicalSerialize(entry.plan);
}

function validStoredJob(job     ) {
  if (job === null) return true;
  if (!isPlainObject(job) || !JOB_ID_RE.test(job.jobId || "") || !JOB_STATES.has(job.state)) return false;
  if (typeof job.profileId !== "string" || !job.profileId) return false;
  return typeof job.syncedDigest === "string" && typeof job.planDigest === "string";
}

const LIVEUI_TASK_SCHEDULE_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "taskId", "plans", "job", "digest"],
  lists: {
    plans: { by: "taskVersionId", replaced: true, fields: ["taskVersionId", "requestDigest", "authoredBy", "plan"] },
  },
});

function validScheduleRecord(record     , taskId     ) {
  if (!isPlainObject(record)) return false;
  const { digest, ...rest } = record;
  if (typeof digest !== "string" || digest !== liveuiLibraryDigest(rest)) return false;
  return validScheduleFields(knownFields(record, LIVEUI_TASK_SCHEDULE_SAVED_SHAPE), taskId);
}

function validScheduleFields(record     , taskId     ) {
  if (!isPlainObject(record) || record.schemaVersion !== LIVEUI_TASK_SCHEDULE_SCHEMA_VERSION) return false;
  if (record.taskId !== taskId || !Array.isArray(record.plans) || record.plans.length > 3) return false;
  return record.plans.every(validStoredPlan) && validStoredJob(record.job);
}

function createLiveuiTaskScheduleStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const directory = path.join(libraryDir, LIVEUI_TASK_SCHEDULE_DIRNAME);

  function recordPath(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) throw new Error("LiveUI Task schedule taskId is invalid");
    return path.join(directory, `${taskId}.json`);
  }

  function read(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return rejected("task_id_invalid", "taskId is invalid");
    let raw;
    try {
      raw = fs.readFileSync(recordPath(taskId), "utf8");
    } catch (err     ) {
      if (err && err.code === "ENOENT") return { status: "accepted", record: null };
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = null;
    }

    if (!validScheduleRecord(parsed, taskId)) {
      return rejected("task_schedule_record_invalid", "the Task's schedule record is invalid");
    }

    return { status: "accepted", record: knownFields(parsed, LIVEUI_TASK_SCHEDULE_SAVED_SHAPE), whole: parsed };
  }

  function write(taskId     , fields     , options      = {}) {
    const current      = read(taskId);
    const currentDigest = current.status === "accepted" && current.record ? current.record.digest : null;
    if (hasOwn(options, "expectedDigest") && options.expectedDigest !== currentDigest) {
      return rejected("task_schedule_conflict", "the Task's schedule changed since it was read", {
        currentDigest,
      });
    }
    const body = {
      schemaVersion: LIVEUI_TASK_SCHEDULE_SCHEMA_VERSION,
      taskId,
      plans: fields.plans,
      job: fields.job,
    };
    const record = { ...body, digest: liveuiLibraryDigest(body) };

    if (!validScheduleFields(record, taskId)) {
      return rejected("task_schedule_record_invalid", "refusing to write an invalid schedule record");
    }

    const before = current.status === "accepted" ? current.whole : null;
    if (before && hasUnknownFields(before, LIVEUI_TASK_SCHEDULE_SAVED_SHAPE)) {
      const { digest: _digest, ...rest } = before;
      const carried = carryUnknownFields(rest, body, LIVEUI_TASK_SCHEDULE_SAVED_SHAPE);
      const kept = { ...carried, digest: liveuiLibraryDigest(carried) };
      atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: recordPath(taskId), record: kept });
      return { status: "saved", record: knownFields(kept, LIVEUI_TASK_SCHEDULE_SAVED_SHAPE) };
    }
    atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: recordPath(taskId), record });
    return { status: "saved", record };
  }

  function remove(taskId     ) {
    try {
      fs.unlinkSync(recordPath(taskId));
    } catch (err     ) {
      if (!err || err.code !== "ENOENT") throw err;
    }
    return { status: "deleted", taskId };
  }

  function list(limit = 200) {
    let names       ;
    try {
      names = fs.readdirSync(directory);
    } catch (err     ) {
      if (err && err.code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((name     ) => typeof name === "string" && name.endsWith(".json"))
      .map((name     ) => name.slice(0, -5))
      .filter((taskId     ) => isValidLiveuiLibraryItemId(taskId))
      .sort()
      .slice(0, limit);
  }

  return { directory, read, write, delete: remove, list };
}

function approvedName(task     ) {
  const approved = task.versions.approved;
  return approved && typeof approved.name === "string" ? approved.name : task.name;
}

function keepsSchedules(scheduler     ) {
  return !!scheduler && (scheduler.host === "hermes" || scheduler.canSchedule === true);
}

function watchesPages(scheduler     ) {
  return !!scheduler && (scheduler.host === "hermes" || scheduler.watchesPages === true);
}

function taskMonitorRefusal(scheduler     , plan     , unsupportedHint = "") {
  if (!isPlainObject(plan) || !plan.monitorUrl) return null;
  if (!watchesPages(scheduler)) {
    return rejected("task_monitor_unsupported", `This host cannot watch a page now${unsupportedHint}`);
  }
  if (scheduler.host !== "hermes" && isPlainObject(plan.when) && plan.when.type === "once") {
    return rejected("task_monitor_needs_repeat", "A page is checked only on a When that repeats");
  }
  return null;
}

function createLiveuiTaskScheduler(opts      = {}) {
  const host = opts.host === "hermes" ? "hermes" : "openclaw";
  const store = createLiveuiTaskScheduleStore({ libraryDir: opts.libraryDir, fs: opts.fs });
  const taskLibrary = typeof opts.taskLibrary === "function" ? opts.taskLibrary : () => opts.taskLibrary;

  const transport = opts.transport || createTaskScheduleTransport({
    request: opts.request,
    available: host === "hermes" || typeof opts.available === "function" ? opts.available : () => false,
    newRequestId: opts.newRequestId,
  });
  const schedules = () => host === "hermes" || transport.available === true;

  const pagesWatched = () => {
    if (host === "hermes") return true;
    try {
      return schedules() && typeof opts.watchesPages === "function" && opts.watchesPages() === true;
    } catch (_) {
      return false;
    }
  };
  const logger = opts.logger && typeof opts.logger.warn === "function" ? opts.logger : null;

  const looks = isPlainObject(opts.looks) ? opts.looks : {};
  const lookCard = (templateId     ) => {
    try {
      return typeof looks.card === "function" ? looks.card(templateId) : null;
    } catch (_) {
      return null;
    }
  };
  const programCardLookFor = (taskId     ) => {
    try {
      return typeof looks.programCard === "function" ? looks.programCard(taskId) : null;
    } catch (_) {
      return null;
    }
  };
  const lookFilledBy = (templateId     , taskId     ) => {
    try {
      const resultId = typeof looks.filledBy === "function" ? looks.filledBy(templateId, taskId) : null;
      return typeof resultId === "string" && resultId ? resultId : null;
    } catch (_) {
      return null;
    }
  };
  const resolveProfileId = typeof opts.resolveProfileId === "function"
    ? opts.resolveProfileId
    : (task     ) => {
      const executor = task && task.versions && task.versions.approved && task.versions.approved.executor;
      if (executor && executor.host === host && executor.agentId) return executor.agentId;

      return host === "hermes" ? "default" : "main";
    };

  function unsupported() {
    return rejected("task_schedule_unsupported", "This host cannot schedule a Task");
  }

  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => Date.now();
  const setTimeoutFn = typeof opts.setTimeoutFn === "function" ? opts.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof opts.clearTimeoutFn === "function" ? opts.clearTimeoutFn : clearTimeout;
  const syncTries = new Map                                                                     ();
  const syncTimers = new Map             ();

  const refusedResends = new Map                ();

  function syncOf(taskId        ) {
    const tries = syncTries.get(taskId);
    return tries ? { ...tries } : { tries: 0, code: null, nextTryAtMs: null };
  }

  function clearSync(taskId        ) {
    syncTries.delete(taskId);
    const timer = syncTimers.get(taskId);
    if (timer !== undefined) clearTimeoutFn(timer);
    syncTimers.delete(taskId);
  }

  function stateOf(taskId        ) {
    try {
      const read      = scheduler.read(taskId);
      return read && read.status === "accepted" ? read.schedule.state : null;
    } catch (_) {
      return null;
    }
  }

  const onSyncChanged = typeof opts.onSyncChanged === "function" ? opts.onSyncChanged : null;
  function syncChanged() {
    try {
      if (onSyncChanged) onSyncChanged();
    } catch (_) {

    }
  }

  function noteSync(taskId        , outcome     )          {
    if (!outcome || typeof outcome !== "object") return false;
    if (outcome.status === "accepted" || outcome.status === "deleted") {
      const had = syncTries.has(taskId);
      clearSync(taskId);
      return had;
    }
    const code = typeof outcome.code === "string" ? outcome.code : "";
    if (outcome.status !== "rejected" || !code.startsWith("task_schedule_")) return false;

    if ((outcome.schedule ? outcome.schedule.state : stateOf(taskId)) !== "unsynced") return false;
    const tries = syncOf(taskId).tries + 1;
    const nextTryAtMs = tries < TASK_SYNC_TRIES_MAX ? nowMs() + TASK_SYNC_RETRY_EVERY_MS : null;
    clearSync(taskId);
    syncTries.set(taskId, { tries, code: taskSyncError(code), nextTryAtMs });
    if (nextTryAtMs === null) return true;
    const timer = setTimeoutFn(() => {
      syncTimers.delete(taskId);
      Promise.resolve(scheduler.retrySync(taskId)).catch(() => {});
    }, TASK_SYNC_RETRY_EVERY_MS);
    if (timer && typeof timer.unref === "function") timer.unref();
    syncTimers.set(taskId, timer);
    return true;
  }

  function loadTask(taskId     ) {
    const loaded      = taskLibrary().read(taskId);
    return loaded && loaded.status === "accepted" ? { status: "accepted", task: loaded.task } : loaded;
  }

  function prunedPlans(task     , plans     ) {
    const versions = task ? Object.values(task.versions) : [];
    return plans.filter((entry     ) => versions.some((version     ) => boundTo(entry, version)));
  }

  function planFor(task     , record     , slot     ) {
    const version = task.versions[slot];
    const entry = record && version ? record.plans.find((candidate     ) => boundTo(candidate, version)) : null;
    return entry ? entry.plan : null;
  }

  function templatePayload(templateId        ) {
    const card      = lookCard(templateId);
    if (!isPlainObject(card) || !Array.isArray(card.inputs) || card.inputs.length === 0) return null;
    return {
      templateId,
      name: typeof card.name === "string" && card.name.trim() ? card.name.trim().slice(0, 120) : templateId,
      inputs: card.inputs,
      ...(typeof card.digest === "string" ? { digest: card.digest } : {}),
      ...(card.taskPresentation === true ? { taskPresentation: true } : {}),
    };
  }

  function lookPayload(plan     , taskId      = null) {
    if (!plan) return null;
    const own = isPlainObject(plan.look) && plan.look.kind === "template" ? templatePayload(plan.look.templateId) : null;
    if (own) return own;
    const fed = typeof taskId === "string" ? programCardLookFor(taskId) : null;
    if (fed) return fed;
    if (isPlainObject(plan.look)) return null;
    const starterLook = taskLookTemplateId(plan);
    return typeof starterLook === "string" ? templatePayload(starterLook) : null;
  }

  function syncDigests(task     , plan     , look      = null) {
    const approved = task.versions.approved;
    return {
      planDigest: liveuiLibraryDigest(plan),
      syncedDigest: liveuiLibraryDigest({
        plan,
        request: approved.request,
        name: approvedName(task),
        versionId: approved.versionId,

        ...(look ? { look: look.digest || look.templateId } : {}),

        ...(look ? { promptContract: TASK_UNCHECKED_PROMPT_CONTRACT } : {}),

        ...(startsWithHostGlassesRules(approved.request, host)
          ? { rulesOnce: TASK_RULES_ONCE_PROMPT_CONTRACT }
          : look?.taskPresentation === true ? {} : { hostRules: TASK_HOST_RULES_PROMPT_CONTRACT }),
      }),
    };
  }

  function owesHostRules(task     , look     , job     ) {
    return look?.taskPresentation === true && !startsWithHostGlassesRules(task.versions.approved.request, host) &&
      job?.hostRules !== TASK_HOST_RULES_PROMPT_CONTRACT;
  }

  function hostRulesMark(task     , look     ) {
    return look?.taskPresentation === true && !startsWithHostGlassesRules(task.versions.approved.request, host)
      ? { hostRules: TASK_HOST_RULES_PROMPT_CONTRACT } : {};
  }

  function stalePresentationJob(taskId        ) {
    const loaded = loadTask(taskId), record = readRecord(taskId).record;
    if (loaded.status !== "accepted" || !record?.job) return false;
    const plan = planFor(loaded.task, record, "approved");
    const look = plan ? lookPayload(plan, taskId) : programCardLookFor(taskId);
    return look?.taskPresentation === true && (!plan ||
      record.job.syncedDigest !== syncDigests(loaded.task, plan, look).syncedDigest);
  }

  function project(task     , record     ) {
    const job = record && record.job;
    const approved = task ? planFor(task, record, "approved") : null;
    return {
      taskId: task ? task.taskId : record && record.taskId,
      host,
      approved,
      pending: task ? planFor(task, record, "pending") : null,
      job: job
        ? { jobId: job.jobId, state: job.state, ...(job.timeZone ? { timeZone: job.timeZone } : {}) }
        : null,
      state: !approved || !approved.when
        ? "none"
        : !job
          ? "unsynced"
          : job.state === "gone"
            ? "job_missing"
            : job.state,
      digest: record ? record.digest : null,
    };
  }

  function readRecord(taskId     ) {
    const loaded      = store.read(taskId);
    if (loaded.status !== "accepted") return loaded;
    return { status: "accepted", record: loaded.record };
  }

  function saveRecord(taskId     , record     , fields     ) {
    return store.write(taskId, {
      plans: hasOwn(fields, "plans") ? fields.plans : record ? record.plans : [],
      job: hasOwn(fields, "job") ? fields.job : record ? record.job : null,
    }, { expectedDigest: record ? record.digest : null });
  }

  function warn(message     ) {
    if (logger) logger.warn(`[liveui-task-schedule] ${message}`);
  }

  let resending                         = null;

  const scheduler      = {
    host,

    get canSchedule() {
      return schedules();
    },

    get watchesPages() {
      return pagesWatched();
    },
    store,
    read(taskId     ) {
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted") return loaded;
      const record      = readRecord(taskId);
      if (record.status !== "accepted") return record;
      return { status: "accepted", schedule: project(loaded.task, record.record) };
    },

    listForGlasses() {
      const rows        = [];
      for (const taskId of store.list()) {
        let read     ;
        try {
          read = scheduler.read(taskId);
        } catch (_) {
          continue;
        }
        if (!read || read.status !== "accepted" || !read.schedule.approved) continue;
        const schedule = read.schedule;
        const job = schedule.job && schedule.job.state !== "gone" ? schedule.job : null;

        const lookTemplateId = taskLookTemplateId(schedule.approved);
        rows.push({
          taskId,
          kind: schedule.approved.kind,
          when: schedule.approved.when,
          jobId: job ? job.jobId : null,
          state: schedule.state,

          ...(isTaskMonitorUrl(schedule.approved.monitorUrl) ? { monitorUrl: schedule.approved.monitorUrl } : {}),

          ...(schedule.approved.starter && typeof schedule.approved.starter.key === "string"
            ? { starterKey: schedule.approved.starter.key }
            : {}),
          ...(typeof lookTemplateId === "string"
            ? { lookTemplateId, lookResultId: lookFilledBy(lookTemplateId, taskId) }
            : {}),

          ...(schedule.state === "unsynced" ? { sync: syncOf(taskId) } : {}),
        });
      }
      return rows;
    },

    listStarterJobs() {
      const rows        = [];
      for (const taskId of store.list()) {
        let read     ;
        try {
          read = scheduler.read(taskId);
        } catch (_) {
          continue;
        }
        if (!read || read.status !== "accepted" || !read.schedule.approved) continue;

        const stored      = readRecord(taskId);
        const job = stored.status === "accepted" && stored.record && stored.record.job;
        if (!job || job.state === "gone") continue;
        const approved = read.schedule.approved;
        rows.push({
          taskId,
          jobId: job.jobId,
          profileId: job.profileId,
          starter: isPlainObject(approved.starter) ? approved.starter.key : null,
          timeZone: approved.when && typeof approved.when.timeZone === "string" ? approved.when.timeZone : null,
        });
      }
      return rows;
    },

    lookForResult(result     )                {
      const jobId = isPlainObject(result) && typeof result.jobId === "string" ? result.jobId : null;
      if (jobId) {
        for (const taskId of store.list()) {
          let read     ;
          try {
            read = scheduler.read(taskId);
          } catch (_) {
            continue;
          }
          if (!read || read.status !== "accepted" || !read.schedule.job || read.schedule.job.jobId !== jobId) continue;
          if (stalePresentationJob(taskId)) return null;
          const lookTemplateId = taskLookTemplateId(read.schedule.approved);
          if (lookTemplateId !== undefined) return lookTemplateId;
          break;
        }
      }
      return ocuclawStarterLookFor(result);
    },

    taskForResult(result     )                {
      const jobId = isPlainObject(result) && typeof result.jobId === "string" ? result.jobId : null;
      if (!jobId) return null;
      for (const taskId of store.list()) {
        let read     ;
        try {
          read = scheduler.read(taskId);
        } catch (_) {
          continue;
        }
        if (read && read.status === "accepted" && read.schedule.job && read.schedule.job.jobId === jobId)
          return stalePresentationJob(taskId) ? null : taskId;
      }
      return null;
    },

    offersLook(taskId     , templateId     ) {
      if (!schedules() || !isValidLiveuiLibraryItemId(templateId)) return false;
      let read     ;
      try {
        read = scheduler.read(taskId);
      } catch (_) {
        return false;
      }
      if (!read || read.status !== "accepted" || !read.schedule.approved) return false;
      return taskLookTemplateId(read.schedule.approved) !== templateId;
    },

    async setLook(taskId     , look     , options      = {}) {
      if (!schedules()) return unsupported();
      const checked      = validateLook(look);
      if (checked.status !== "accepted") return checked;
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted") return loaded;
      const recordLoaded      = readRecord(taskId);
      if (recordLoaded.status !== "accepted") return recordLoaded;
      const approved = planFor(loaded.task, recordLoaded.record, "approved");
      if (!approved) return rejected("task_schedule_none", "This Task has no approved schedule");
      const { look: _previous, ...rest } = approved;
      return scheduler.set(taskId, { ...rest, ...(checked.look ? { look: checked.look } : {}) }, {
        expectedDigest: loaded.task.digest,
        authoredBy: options.authoredBy === "agent" ? "agent" : "phone",
      });
    },

    propose(taskId     , planInput     , options      = {}) {
      if (!schedules()) return unsupported();
      const validation      = validateTaskSchedulePlan(planInput);
      if (validation.status !== "accepted") return validation;
      const plan = validation.plan;
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted") return loaded;
      let task = loaded.task;
      if (typeof options.expectedDigest !== "string" || options.expectedDigest !== task.digest) {
        return rejected("library_conflict", "saved item changed since it was read", { currentDigest: task.digest });
      }
      const recordLoaded      = readRecord(taskId);

      const record = recordLoaded.status === "accepted" ? recordLoaded.record : null;
      if (recordLoaded.status !== "accepted" && options.replaceInvalid !== true) return recordLoaded;
      const authoredBy = options.authoredBy === "agent" ? "agent" : "phone";
      const approvedPlan = planFor(task, record, "approved");
      const job = record ? record.job : null;
      const same = (left     ) => !!left && canonicalSerialize(left) === canonicalSerialize(plan);

      const needsWhen = taskMonitorNeedsWhen(plan);
      if (needsWhen && !(approvedPlan && approvedPlan.monitorUrl === plan.monitorUrl)) return needsWhen;

      if (task.versions.approved && (same(approvedPlan) || isTaskScheduleRelaxation(approvedPlan, plan))) {
        if (same(approvedPlan) && !(job && job.state === "gone")) {
          return { status: "unchanged", applied: "unchanged", schedule: project(task, record) };
        }
        const entry = { ...taskScheduleBinding(task.versions.approved), plan, authoredBy };
        const others = (record ? record.plans : []).filter((candidate     ) => !boundTo(candidate, task.versions.approved));

        const nextJob = job && job.state === "gone" ? null : job;
        const saved      = saveRecord(taskId, record, { plans: prunedPlans(task, [entry, ...others]), job: nextJob });
        if (saved.status !== "saved") return saved;
        return { status: "saved", applied: "now", schedule: project(task, saved.record) };
      }

      if (!task.versions.pending) {
        if (typeof taskLibrary().createDraftFromApproved !== "function") {
          return rejected("task_schedule_unsupported", "this Task Library cannot open a Draft for a When");
        }
        const opened      = taskLibrary().createDraftFromApproved(taskId, {
          expectedDigest: task.digest,
          authoredBy,
        });
        if (opened.status !== "saved") return opened;
        task = opened.task;
      } else {
        const pendingPlan = planFor(task, record, "pending");
        if (same(pendingPlan)) return { status: "unchanged", applied: "unchanged", schedule: project(task, record) };
        if (pendingPlan && options.replacePendingDraft !== true) {
          return rejected(
            "task_draft_pending",
            "A pending Draft already carries a When. Ask the user before replacing it, then pass replacePendingDraft: true.",
          );
        }
      }
      const entry = { ...taskScheduleBinding(task.versions.pending), plan, authoredBy };
      const others = (record ? record.plans : []).filter((candidate     ) => !boundTo(candidate, task.versions.pending));

      const saved      = saveRecord(taskId, record, { plans: prunedPlans(task, [entry, ...others]), job });
      if (saved.status !== "saved") return saved;
      return { status: "saved", applied: "draft", task, schedule: project(task, saved.record) };
    },

    keepPlan(taskId     ) {
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted") return loaded;
      const task = loaded.task;
      const { approved, previous } = task.versions;
      if (!approved || !previous) return { status: "unchanged" };
      const recordLoaded      = readRecord(taskId);
      if (recordLoaded.status !== "accepted") return recordLoaded;
      const record = recordLoaded.record;
      if (!record || planFor(task, record, "approved")) return { status: "unchanged" };
      const kept = record.plans.find((candidate     ) => boundTo(candidate, previous));
      if (!kept) return { status: "unchanged" };
      const entry = {
        ...taskScheduleBinding(approved),
        plan: keptPlan(kept.plan, previous, approved),
        authoredBy: kept.authoredBy,
      };
      const saved      = saveRecord(taskId, record, { plans: prunedPlans(task, [entry, ...record.plans]) });
      if (saved.status !== "saved") return saved;
      return { status: "saved", schedule: project(task, saved.record) };
    },

    async set(taskId     , planInput     , options      = {}) {
      const proposed      = scheduler.propose(taskId, planInput, options);
      if (proposed.status !== "saved" || proposed.applied !== "now") return proposed;
      const synced      = await scheduler.reconcile(taskId);
      return { ...proposed, sync: synced, schedule: synced.schedule || proposed.schedule };
    },

    async reconcile(taskId     , options      = {}) {
      if (typeof taskId !== "string") return scheduler.reconcileJob(taskId, options);
      const wasUnsynced = stateOf(taskId) === "unsynced";
      const outcome      = await scheduler.reconcileJob(taskId, options);

      if (noteSync(taskId, outcome) || (wasUnsynced && stateOf(taskId) !== "unsynced")) syncChanged();
      return outcome;
    },

    async retrySync(taskId     ) {
      if (syncOf(taskId).tries >= TASK_SYNC_TRIES_MAX || stateOf(taskId) !== "unsynced") return null;
      return scheduler.reconcile(taskId);
    },

    async retryUnsynced() {
      let tried = 0;
      for (const taskId of store.list()) {
        if (syncOf(taskId).tries >= TASK_SYNC_TRIES_MAX || stateOf(taskId) !== "unsynced") continue;
        tried += 1;
        try {
          await scheduler.reconcile(taskId);
        } catch (_) {

        }
      }
      return tried;
    },

    resendStale()                  {

      const sweep                  = resending || scheduler.resendStaleOnce().finally(() => { resending = null; });
      resending = sweep;
      return sweep;
    },

    async resendStaleOnce() {
      if (!schedules()) return 0;
      let resent = 0;
      for (const taskId of store.list()) {
        try {
          const loaded      = loadTask(taskId);
          if (loaded.status !== "accepted") continue;
          const recordLoaded      = readRecord(taskId);
          const record = recordLoaded.status === "accepted" ? recordLoaded.record : null;
          const job = record ? record.job : null;
          if (!job || job.state === "gone") continue;
          const plan = planFor(loaded.task, record, "approved");
          if (!plan || !plan.when) continue;
          const look      = lookPayload(plan, taskId);
          const digest = syncDigests(loaded.task, plan, look).syncedDigest;

          const target = look?.taskPresentation === true
            ? (job.syncedDigest === digest && owesHostRules(loaded.task, look, job) ? `${digest}+hostRules` : null)
            : (job.syncedDigest === digest ? null : digest);
          if (target === null) continue;

          if (refusedResends.get(taskId) === target) continue;
          resent += 1;
          const outcome      = await scheduler.reconcile(taskId);
          if (outcome?.status === "accepted") refusedResends.delete(taskId);
          else refusedResends.set(taskId, target);
        } catch (_) {

        }
      }
      return resent;
    },

    async syncAgain(taskId     ) {
      if (typeof taskId === "string") clearSync(taskId);
      return scheduler.reconcile(taskId, { recreateGone: true });
    },

    syncOf(taskId     ) {
      return syncOf(taskId);
    },

    dispose() {
      for (const taskId of [...syncTimers.keys()]) clearSync(taskId);
      syncTries.clear();
    },

    async reconcileJob(taskId     , options      = {}) {
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted") {
        if (loaded.code === "task_not_found") return scheduler.onTaskDeleted(taskId);
        return loaded;
      }
      const task = loaded.task;
      const recordLoaded      = readRecord(taskId);
      if (recordLoaded.status !== "accepted") return recordLoaded;
      let record = recordLoaded.record;
      const plan = planFor(task, record, "approved");
      let job = record ? record.job : null;
      if (record) {
        const plans = prunedPlans(task, record.plans);
        if (plans.length !== record.plans.length) {
          const saved      = saveRecord(taskId, record, { plans });
          if (saved.status !== "saved") return saved;
          record = saved.record;
        }
      }
      if (!plan || !plan.when) {
        if (!job || job.state === "gone") {
          if (job) {
            const saved      = saveRecord(taskId, record, { job: null });
            if (saved.status !== "saved") return saved;
            record = saved.record;
          }
          return { status: "accepted", state: "none", schedule: project(task, record) };
        }
        return removeJob(task, record, job);
      }
      if (!schedules()) return unsupported();

      const look      = lookPayload(plan, taskId);
      const digests = syncDigests(task, plan, look);

      let replacing      = null;
      if (job && job.state === "gone" && job.planDigest === digests.planDigest && options.recreateGone !== true) {
        return { status: "accepted", state: "job_missing", schedule: project(task, record) };
      }
      if (job && job.state !== "gone" && look?.taskPresentation === true && job.syncedDigest !== digests.syncedDigest) {

        if (job.state === "paused" && options.resumePaused !== true)
          return { status: "accepted", state: "paused", schedule: project(task, record) };

        if (job.profileId === resolveProfileId(task)) {
          replacing = job;
        } else {
          const removed = await removeJob(task, record, job);
          if (removed?.status !== "accepted") return removed;
          const latest = readRecord(taskId);
          if (latest.status !== "accepted") return latest;
          record = latest.record;
        }
        job = null;
      }
      const payload      = {
        taskId,
        name: approvedName(task),
        request: task.versions.approved.request,
        kind: plan.kind,
        when: plan.when,
        ...(plan.starter ? { starter: plan.starter } : {}),
        ...(plan.monitorUrl ? { monitorUrl: plan.monitorUrl } : {}),
        ...(look ? { look: { name: look.name, inputs: look.inputs } } : {}),
      };
      const live = job && job.state !== "gone" ? job : null;
      const profileId = live ? live.profileId : resolveProfileId(task);
      if (!live) {
        const created      = await transport.call("taskSchedule.create", profileId,
          replacing ? { ...payload, replacesJobId: replacing.jobId } : payload);

        if (created.status !== "ok") return syncFailure(task, record, created);
        return saveJob(task, record, {
          jobId: created.job.id,
          profileId,
          state: created.job.paused ? "paused" : "active",
          ...digests,
          ...hostRulesMark(task, look),
          ...(created.job.timeZone ? { timeZone: created.job.timeZone } : {}),
        });
      }

      if (live.syncedDigest !== digests.syncedDigest || owesHostRules(task, look, live)) {
        const updated      = await transport.call("taskSchedule.update", profileId, { ...payload, jobId: live.jobId });
        if (updated.status !== "ok") return syncFailure(task, record, updated, live);
        return saveJob(task, record, {
          ...live,
          ...digests,
          ...hostRulesMark(task, look),
          state: updated.job.paused ? "paused" : "active",
          ...(updated.job.timeZone ? { timeZone: updated.job.timeZone } : {}),
        });
      }
      const status      = await transport.call("taskSchedule.status", profileId, {
        taskId,
        jobId: live.jobId,
        when: plan.when,
      });
      if (status.status !== "ok") return syncFailure(task, record, status, live);
      if (status.job.scheduleDrift) {

        const resent      = await transport.call("taskSchedule.update", profileId, { ...payload, jobId: live.jobId });
        if (resent.status !== "ok") return syncFailure(task, record, resent, live);
        return saveJob(task, record, {
          ...live,
          ...(resent.job.timeZone ? { timeZone: resent.job.timeZone } : {}),
        });
      }
      const state = status.job.paused ? "paused" : "active";
      if (state !== live.state) return saveJob(task, record, { ...live, state });
      return { status: "accepted", state, job: status.job, schedule: project(task, record) };
    },

    async pause(taskId     ) {
      return lifecycle(taskId, "taskSchedule.pause", "paused");
    },
    async resume(taskId     ) {
      if (stalePresentationJob(taskId)) {
        const synced = await scheduler.reconcile(taskId, { resumePaused: true });
        if (synced.status !== "accepted" || synced.state === "active") return synced;
      }
      return lifecycle(taskId, "taskSchedule.resume", "active");
    },
    async runNow(taskId     ) {
      return lifecycle(taskId, "taskSchedule.run", null);
    },
    async status(taskId     ) {
      return lifecycle(taskId, "taskSchedule.status", null);
    },

    async testRun(testTaskId     , name     , request     , plan     , profileId      = "default", options      = {}) {
      if (!schedules()) return unsupported();

      const look      = options?.openCard === true ? lookPayload({ ...plan, starter: undefined }) : lookPayload(plan);

      const openCard = options?.openCard === true && !look;
      return transport.call("taskSchedule.test", profileId, {
        taskId: testTaskId,
        name,
        request,
        kind: plan.kind,
        ...(plan.starter ? { starter: plan.starter } : {}),
        ...(look ? { look: { name: look.name, inputs: look.inputs } } : {}),
        ...(openCard ? { openCard: true } : {}),

        ...(openCard && Array.isArray(options?.inputs) && options.inputs.length > 0 ? { cardInputs: options.inputs } : {}),
      });
    },

    async testEnd(testTaskId     , jobId     , profileId      = "default") {
      if (!schedules()) return unsupported();
      return transport.call("taskSchedule.testEnd", profileId, { taskId: testTaskId, jobId });
    },

    async fillStarter(starter     , profileId      = "default") {
      if (!schedules()) return unsupported();
      return transport.call("taskSchedule.fillStarter", profileId, { starter });
    },

    async starterChange(taskId     ) {
      const none = { changed: false, prompt: null };
      if (!schedules()) return none;
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted" || loaded.task.versions.pending || !loaded.task.versions.approved) return none;
      const recordLoaded      = readRecord(taskId);
      if (recordLoaded.status !== "accepted") return none;
      const plan = planFor(loaded.task, recordLoaded.record, "approved");
      if (!plan || !plan.starter) return none;
      const job = recordLoaded.record ? recordLoaded.record.job : null;
      const profileId = job && job.state !== "gone" ? job.profileId : resolveProfileId(loaded.task);
      const filled      = await transport.call("taskSchedule.fillStarter", profileId, { starter: plan.starter });
      if (!filled || filled.status !== "ok") return none;
      const prompt = filled.starter.prompt;
      const approved = String(loaded.task.versions.approved.request || "");
      return prompt.trim() !== approved.trim() ? { changed: true, prompt } : none;
    },

    async reviewStarterChange(taskId     , options      = {}) {
      if (!schedules()) return unsupported();
      const change      = await scheduler.starterChange(taskId);
      if (!change.changed) return rejected("task_starter_unchanged", "The Starter has not changed");
      const library = taskLibrary();
      if (typeof library.updateDraft !== "function") {
        return rejected("task_schedule_unsupported", "this Task Library cannot open a Draft");
      }
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted") return loaded;
      if (typeof options.expectedDigest === "string" && options.expectedDigest !== loaded.task.digest) {
        return rejected("library_conflict", "saved item changed since it was read", { currentDigest: loaded.task.digest });
      }
      const recordLoaded      = readRecord(taskId);
      if (recordLoaded.status !== "accepted") return recordLoaded;
      const approvedPlan = planFor(loaded.task, recordLoaded.record, "approved");

      const updated      = library.updateDraft(
        { taskId, expectedDigest: loaded.task.digest, request: change.prompt },
        { authoredBy: "phone" },
      );
      if (!updated || updated.status !== "saved") return updated || rejected("task_save_failed", "the Draft was not saved");
      const draft = updated.task;
      if (approvedPlan && draft.versions.pending) {
        const entry = { ...taskScheduleBinding(draft.versions.pending), plan: approvedPlan, authoredBy: "phone" };
        const fresh      = readRecord(taskId);
        const record = fresh.status === "accepted" ? fresh.record : null;
        const others = (record ? record.plans : []).filter((candidate     ) => !boundTo(candidate, draft.versions.pending));
        const saved      = saveRecord(taskId, record, { plans: prunedPlans(draft, [entry, ...others]) });
        if (saved.status !== "saved") return saved;
      }
      return { status: "saved", task: draft };
    },

    async readForeignJob(jobId     , profileId      = "default") {
      if (!schedules()) return unsupported();
      return transport.call("taskSchedule.foreign", profileId, { jobId });
    },

    async adoptJob(taskId     , jobId     , profileId      = "default") {
      if (!schedules()) return unsupported();
      const loaded      = loadTask(taskId);
      if (loaded.status !== "accepted") return loaded;
      const recordLoaded      = readRecord(taskId);
      if (recordLoaded.status !== "accepted") return recordLoaded;
      const adopted      = await transport.call("taskSchedule.adopt", profileId, { taskId, jobId });
      if (!adopted || adopted.status !== "ok") {
        return rejected(`task_schedule_${(adopted && adopted.code) || "failed"}`, "Hermes could not hand over that job");
      }
      const saved      = saveRecord(taskId, recordLoaded.record, {
        job: {
          jobId: adopted.job.id,
          profileId,
          state: adopted.job.paused ? "paused" : "active",
          planDigest: "",
          syncedDigest: "",
        },
      });
      if (saved.status !== "saved") return saved;
      return scheduler.reconcile(taskId);
    },

    isQuiet(taskId     ) {
      try {
        const read      = scheduler.read(taskId);
        return !!(read && read.status === "accepted" && read.schedule.approved &&
          read.schedule.approved.popUp === false);
      } catch (_) {
        return false;
      }
    },

    async onTaskDeleted(taskId     ) {
      if (typeof taskId === "string") clearSync(taskId);
      const recordLoaded      = readRecord(taskId);
      if (recordLoaded.status !== "accepted") {
        store.delete(taskId);
        return { status: "deleted", taskId };
      }
      const record = recordLoaded.record;
      const job = record ? record.job : null;
      if (job && job.state !== "gone") {
        if (!schedules()) {
          warn(`task ${taskId} deleted while its Hermes job ${job.jobId} is unreachable`);
          return { status: "rejected", code: "task_schedule_unsupported", taskId, jobId: job.jobId };
        }
        const deleted      = await transport.call("taskSchedule.delete", job.profileId, {
          taskId,
          jobId: job.jobId,
        });
        if (deleted.status !== "ok" && deleted.code !== "job_not_owned") {
          warn(`task ${taskId} deleted; its Hermes job delete is pending (${deleted.code})`);
          return { status: "pending", code: deleted.code, taskId, jobId: job.jobId };
        }
      }
      store.delete(taskId);
      return { status: "deleted", taskId };
    },
  };

  async function removeJob(task     , record     , job     ) {
    if (!schedules()) return unsupported();
    const deleted      = await transport.call("taskSchedule.delete", job.profileId, {
      taskId: task.taskId,
      jobId: job.jobId,
    });
    if (deleted.status !== "ok" && deleted.code !== "job_not_owned") return syncFailure(task, record, deleted, job);
    const saved      = saveRecord(task.taskId, record, { job: null });
    if (saved.status !== "saved") return saved;
    return { status: "accepted", state: "none", schedule: project(task, saved.record) };
  }

  function saveJob(task     , record     , job     ) {
    const saved      = saveRecord(task.taskId, record, { job });
    if (saved.status !== "saved") return saved;
    return { status: "accepted", state: job.state, schedule: project(task, saved.record) };
  }

  function markGone(task     , record     , job     ) {
    const saved      = saveRecord(task.taskId, record, { job: { ...job, state: "gone" } });
    if (saved.status !== "saved") return saved;
    return { status: "accepted", state: "job_missing", schedule: project(task, saved.record) };
  }

  function syncFailure(task     , record     , result     , job      = null) {
    if (job && (result.code === "job_missing" || result.code === "job_not_owned")) {
      return markGone(task, record, job);
    }

    warn(`sync refused (${result.code || "failed"})`);
    return rejected(`task_schedule_${result.code || "failed"}`, "The Task's Hermes job could not be synced", {
      ...(result.starterPrompt ? { starterPrompt: result.starterPrompt } : {}),
      schedule: project(task, record),
    });
  }

  async function lifecycle(taskId     , operation     , nextState     ) {
    if (!schedules()) return unsupported();
    const loaded      = loadTask(taskId);
    if (loaded.status !== "accepted") return loaded;
    const task = loaded.task;
    const recordLoaded      = readRecord(taskId);
    if (recordLoaded.status !== "accepted") return recordLoaded;
    const record = recordLoaded.record;
    const job = record ? record.job : null;
    if (!job) return rejected("task_schedule_none", "This Task has no scheduled job");
    if (job.state === "gone") {
      return { status: "accepted", state: "job_missing", schedule: project(task, record) };
    }
    const plan = planFor(task, record, "approved");
    const result      = await transport.call(operation, job.profileId, {
      taskId,
      jobId: job.jobId,
      ...(operation === "taskSchedule.status" && plan && plan.when ? { when: plan.when } : {}),
    });
    if (result.status !== "ok") return syncFailure(task, record, result, job);
    const state = nextState || (result.job.paused ? "paused" : "active");
    if (state !== job.state) {
      const saved      = saveJob(task, record, { ...job, state });
      return saved.status === "accepted" ? { ...saved, job: result.job } : saved;
    }
    return { status: "accepted", state, job: result.job, schedule: project(task, record) };
  }

  return scheduler;
}

module.exports = { LIVEUI_TASK_SCHEDULE_SCHEMA_VERSION, TASK_RULES_ONCE_PROMPT_CONTRACT, TASK_HOST_RULES_PROMPT_CONTRACT, LIVEUI_TASK_SCHEDULE_DIRNAME, LIVEUI_TASK_KINDS, LIVEUI_TASK_WHEN_DAYS, isTaskMonitorUrl, taskMonitorNeedsWhen, taskWindowHours, validateTaskWhen, LIVEUI_TASK_LOOK_KINDS, taskLookTemplateId, validateTaskSchedulePlan, taskScheduleBinding, isTaskScheduleRelaxation, LIVEUI_TASK_SCHEDULE_SAVED_SHAPE, createLiveuiTaskScheduleStore, keepsSchedules, watchesPages, taskMonitorRefusal, createLiveuiTaskScheduler };
