const { isTaskMonitorUrl, keepsSchedules, taskMonitorNeedsWhen, taskMonitorRefusal, validateTaskSchedulePlan } = require("./glasses-ui-task-schedule.cjs");
const { taskShortDescription } = require("./glasses-ui-task-description.cjs");
const { describeTaskWhen } = require("./glasses-ui-task-voice.cjs");
const { liveuiLibraryDigest } = require("./glasses-ui-library.cjs");

const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function rejected(code     , message     , extra      = {}) {
  return { status: "rejected", code, message, ...extra };
}

const hasText = (value     ) => typeof value === "string" && value.trim().length > 0;

function slug(text     ) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function createLiveuiTaskSheet(deps      = {}) {
  const enabled = typeof deps.enabled === "function" ? deps.enabled : () => false;
  const newId = typeof deps.newId === "function"
    ? deps.newId
    : () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function off() {
    return rejected("scheduled_tasks_off", "Scheduled Tasks are not turned on in the OcuClaw app");
  }

  function rows() {
    const listed      = deps.listTasks();
    return listed && Array.isArray(listed.tasks) ? listed.tasks : [];
  }

  function digestOf(taskId     ) {
    const loaded      = deps.readTask(taskId);
    return loaded && loaded.status === "accepted" ? loaded.task.digest : null;
  }

  function freeTaskId(name     ) {
    const taken = new Set(rows().map((row     ) => row.itemId || row.taskId));
    const stem = slug(name);
    if (!taken.has(stem) && TASK_ID_RE.test(stem)) return stem;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${stem}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${stem}-${newId()}`.slice(0, 64);
  }

  function freeName(base        ) {
    const names = new Set(rows().map((row     ) => String(row.name || "").trim().toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base} ${n}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }

  async function save(input     , context      = {}) {
    if (!enabled()) return off();
    const scheduler = deps.scheduler();
    if (!scheduler) return rejected("task_schedule_unsupported", "Saving a Task needs a Task scheduler");
    if (!input || typeof input !== "object" || !hasText(input.name)) {
      return rejected("task_name_invalid", "a Task needs a name");
    }

    if (!keepsSchedules(scheduler)) return saveUnscheduled(input, context);
    const profileId = hasText(context.agentId) ? context.agentId : "default";
    const starter = input.starter ? input.starter : null;
    const plan      = validateTaskSchedulePlan({
      when: input.when === undefined ? null : input.when,
      kind: input.kind,
      ...(starter ? { starter } : {}),
      ...(input.popUp === false ? { popUp: false } : {}),
      ...(input.look ? { look: input.look } : {}),

      ...(hasText(input.monitorUrl) ? { monitorUrl: input.monitorUrl.trim() } : {}),
    });
    if (plan.status !== "accepted") return plan;

    const needsWhen = taskMonitorNeedsWhen(plan.plan);
    if (needsWhen) return needsWhen;

    const monitorRefused = taskMonitorRefusal(scheduler, plan.plan);
    if (monitorRefused) return monitorRefused;
    let request = hasText(input.request) ? input.request.trim() : "";
    let starterDescription = "";

    const fromJob = typeof input.fromJob === "string" && input.fromJob ? input.fromJob : null;
    if (fromJob) {
      if (starter) return rejected("task_request_invalid", "a Task made from a job has no starter");
      const foreign      = await scheduler.readForeignJob(fromJob, profileId);
      if (!foreign || foreign.status !== "ok") {
        return rejected(`task_schedule_${(foreign && foreign.code) || "failed"}`, "Hermes could not read that job");
      }
      request = foreign.job.prompt.trim();

      if (!plan.plan.monitorUrl && isTaskMonitorUrl(foreign.job.monitorUrl) &&
          plan.plan.kind !== "reminder" && plan.plan.when !== null &&
          !taskMonitorRefusal(scheduler, { ...plan.plan, monitorUrl: foreign.job.monitorUrl })) {
        plan.plan = { ...plan.plan, monitorUrl: foreign.job.monitorUrl };
      }
    }
    if (starter) {

      const filled      = await scheduler.fillStarter(plan.plan.starter, profileId);
      if (!filled || filled.status !== "ok") {
        return rejected(`task_starter_${(filled && filled.code) || "failed"}`, "Hermes could not fill this starter");
      }
      request = filled.starter.prompt;
      starterDescription = typeof filled.starter.description === "string" ? filled.starter.description : "";
    }
    if (!request) return rejected("task_request_invalid", "a Task in your own words needs a prompt");

    const stableId = typeof context.taskId === "string" && /^setup-[0-9a-f-]{36}$/.test(context.taskId) ? context.taskId : null;
    const previous = stableId ? deps.readTask(stableId) : null;
    const existing = previous?.status === "accepted" ? previous.task : null;
    const version = existing?.versions?.approved || existing?.versions?.pending;
    if (existing && (!version || version.request !== request)) return rejected("presentation_work_changed", "Task changed since this approval");
    if (stableId && !existing && context.allowCreate !== true) return rejected("presentation_task_missing", "The approved Task is missing; do not create a duplicate");
    const name = version?.name || existing?.name || freeName(input.name.trim());
    const taskId = stableId || freeTaskId(name);

    const description = taskShortDescription({
      starterDescription,
      request,
      whenText: describeTaskWhen(plan.plan.when),
    });
    const created      = existing ? { status: "saved", task: existing } : deps.createDraft(
      { taskId, name, request, ...(description ? { description } : {}) },
      { agentId: context.agentId },
    );
    if (!created || created.status !== "saved") return created || rejected("task_save_failed", "the Task was not saved");
    const drop = (refusal     ) => {

      if (stableId) return refusal;
      const digest = digestOf(taskId);
      if (digest) {
        try {
          deps.rejectTask(taskId, digest);
        } catch (_) {

        }
      }
      return refusal;
    };
    if (typeof context.beforeApprove === "function") {

      const binding = await context.beforeApprove(created.task.versions.approved || created.task.versions.pending,
        { ...plan.plan });
      if (!binding || binding.status !== "accepted") return drop(binding || rejected("presentation_binding_failed", "Result was not bound"));
      if (binding.look) plan.plan.look = binding.look;
    }

    if (existing?.versions?.approved) {
      const current = scheduler.read(taskId);
      if (!current || current.status !== "accepted" || liveuiLibraryDigest(current.schedule?.approved) !== liveuiLibraryDigest(plan.plan))
        return rejected("presentation_approval_changed", "The Task schedule changed since this approval");
      const synced = await scheduler.reconcile(taskId);
      return { status: "saved", taskId, name, state: synced?.schedule?.state || synced?.state || "unsynced" };
    }
    const proposed      = scheduler.propose(taskId, plan.plan, {
      expectedDigest: created.task.digest,
      authoredBy: "phone",
    });
    if (!proposed || proposed.status !== "saved") return drop(proposed);
    const approved      = deps.approveTask(taskId, digestOf(taskId));
    if (!approved || approved.status !== "saved") return drop(approved || rejected("task_review_failed", "not approved"));

    const synced      = fromJob
      ? await scheduler.adoptJob(taskId, fromJob, profileId)
      : await scheduler.reconcile(taskId);
    const state = synced && synced.schedule && typeof synced.schedule.state === "string"
      ? synced.schedule.state
      : synced && typeof synced.state === "string" ? synced.state : "unsynced";
    return {
      status: "saved",
      taskId,
      name,
      state,
      ...(synced && synced.status === "rejected" && typeof synced.code === "string" ? { code: synced.code } : {}),

      ...(state === "unsynced" && typeof scheduler.syncOf === "function" ? { sync: scheduler.syncOf(taskId) } : {}),
    };
  }

  function saveUnscheduled(input     , context     ) {
    const needsScheduler = (input.when !== null && input.when !== undefined) || !!input.starter ||
      !!input.fromJob || !!input.presentation || hasText(input.monitorUrl) || typeof context.beforeApprove === "function";
    if (needsScheduler) return rejected("task_schedule_unsupported", "Scheduling a Task needs a host that keeps schedules");
    const request = hasText(input.request) ? input.request.trim() : "";
    if (!request) return rejected("task_request_invalid", "a Task in your own words needs a prompt");
    const name = freeName(input.name.trim());
    const taskId = freeTaskId(name);
    const description = taskShortDescription({ starterDescription: "", request, whenText: describeTaskWhen(null) });
    const created      = deps.createDraft(
      { taskId, name, request, ...(description ? { description } : {}) },
      { agentId: context.agentId },
    );
    if (!created || created.status !== "saved") return created || rejected("task_save_failed", "the Task was not saved");
    const approved      = deps.approveTask(taskId, digestOf(taskId));
    if (!approved || approved.status !== "saved") {
      const digest = digestOf(taskId);
      if (digest) {
        try {
          deps.rejectTask(taskId, digest);
        } catch (_) {

        }
      }
      return approved || rejected("task_review_failed", "not approved");
    }
    return { status: "saved", taskId, name, state: "none" };
  }

  async function run(taskId     ) {
    if (!enabled()) return off();
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return rejected("task_not_found", "no such Task");
    const scheduler = deps.scheduler();
    if (!keepsSchedules(scheduler)) {
      return rejected("task_schedule_unsupported", "Running a Task needs a host that keeps schedules");
    }
    return scheduler.runNow(taskId);
  }

  async function quiet(taskId     ) {
    if (!enabled()) return off();
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return rejected("task_not_found", "no such Task");
    const scheduler = deps.scheduler();
    if (!keepsSchedules(scheduler)) {
      return rejected("task_schedule_unsupported", "A quiet Task needs a host that keeps schedules");
    }
    const read      = scheduler.read(taskId);
    if (!read || read.status !== "accepted") return read || rejected("task_not_found", "no such Task");
    const plan = read.schedule && read.schedule.approved;
    if (!plan || !plan.when) return rejected("task_schedule_none", "This Task has no When to make quiet");
    const digest = digestOf(taskId);
    if (!digest) return rejected("task_not_found", "no such Task");
    return scheduler.set(taskId, { ...plan, popUp: false }, { expectedDigest: digest, authoredBy: "phone" });
  }

  return { save, run, quiet };
}

module.exports = { createLiveuiTaskSheet };
