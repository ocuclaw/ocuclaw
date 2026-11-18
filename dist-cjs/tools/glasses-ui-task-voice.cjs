const { canonicalSerialize } = require("./glasses-ui-library.cjs");
const { taskShortDescription } = require("./glasses-ui-task-description.cjs");
const { isTaskScheduleRelaxation, keepsSchedules, taskMonitorRefusal, validateTaskSchedulePlan, validateTaskWhen } = require("./glasses-ui-task-schedule.cjs");

const CLOCK_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RECURRENCES = ["everyday", "weekdays", "weekends"];
const CONFIRM_TTL_MS = 120_000;

const timeSlot = { type: "time" };
const daysSlot = { type: "choice", options: RECURRENCES };

const OCUCLAW_VOICE_STARTERS                                = Object.freeze({
  "ocuclaw:glasses-brief": { title: "Morning brief", kind: "brief", slots: { time: timeSlot, recurrence: daysSlot } },
  "ocuclaw:day-wrap": { title: "Day wrap-up", kind: "brief", slots: { time: timeSlot, recurrence: daysSlot } },
  "ocuclaw:glance-reminder": {
    title: "Reminder",
    kind: "reminder",
    slots: { text: { type: "text" }, time: timeSlot, recurrence: daysSlot },
  },
});

function rejected(code     , message     , extra      = {}) {
  return { status: "rejected", code, message, ...extra };
}

const isPlainObject = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);
const hasText = (value     ) => typeof value === "string" && value.trim().length > 0;

function classifyVoiceTaskRequest(input     ) {
  if (!isPlainObject(input)) return rejected("task_voice_invalid", "schedule_task needs starter or request, and when");

  if (!isPlainObject(input.when)) return rejected("task_when_invalid", "schedule_task needs a when");
  const when      = validateTaskWhen(input.when);
  if (when.status !== "accepted") return when;
  const starter = input.starter;
  if (starter !== undefined && starter !== null &&
      (!isPlainObject(starter) || typeof starter.key !== "string" ||
       (starter.slots !== undefined && starter.slots !== null && !isPlainObject(starter.slots)))) {
    return rejected("task_starter_invalid", "starter must be { key, slots }");
  }
  const ownWords = hasText(input.request);
  if (!starter && !ownWords) return rejected("task_voice_invalid", "schedule_task needs starter or request");
  if (starter && ownWords) return rejected("task_voice_invalid", "pass starter or request, not both");
  const slots = starter && isPlainObject(starter.slots) ? starter.slots : {};
  const result = (approval     , reason     ) => ({ status: "accepted", approval, reason, when: when.when });
  if (ownWords) return result("phone", "own_words");
  const known = OCUCLAW_VOICE_STARTERS[starter.key];
  if (!known) return result("phone", "not_ocuclaw_starter");
  for (const [name, value] of Object.entries(slots)) {
    const spec = known.slots[name];
    if (!spec) return rejected("task_starter_slot_invalid", `${starter.key} has no slot ${name}`);
    if (spec.type === "time" && (typeof value !== "string" || !CLOCK_RE.test(value))) {
      return rejected("task_starter_slot_invalid", `${name} must be HH:MM`);
    }
    if (spec.type === "choice" && !spec.options.includes(value)) {
      return rejected("task_starter_slot_invalid", `${name} must be one of ${spec.options.join(", ")}`);
    }
    if (spec.type === "text" && typeof value !== "string") {
      return rejected("task_starter_slot_invalid", `${name} must be text`);
    }
  }
  if (Object.keys(slots).some((name) => known.slots[name].type === "text")) return result("phone", "free_text_slot");

  if (hasText(input.monitorUrl)) return result("phone", "monitor_url");
  if (hasText(input.name)) return result("phone", "own_words");
  if (when.when.type === "interval") return result("phone", "interval");
  return result("glasses", "fixed_starter");
}

const DAY_LABELS      = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

function describeTaskWhen(when     ) {
  if (!when) return "only when asked";
  if (when.type === "once") return `once, ${when.at.replace("T", " at ")}`;
  if (when.type === "interval") {
    if (!when.window) return `every ${when.everyMinutes} min`;

    const clock = (hour        ) => `${String(hour).padStart(2, "0")}:00`;
    return `every ${when.everyMinutes} min from ${clock(when.window.fromHour)} to ${clock(when.window.toHour)}, ` +
      describeDays(when.window.days);
  }
  return `${describeDays(when.days)} at ${when.time}`;
}

function describeDays(list       ) {
  const days = list.join(",");
  return days === "mon,tue,wed,thu,fri,sat,sun"
    ? "every day"
    : days === "mon,tue,wed,thu,fri"
      ? "every weekday"
      : days === "sat,sun"
        ? "every weekend"
        : `every ${list.map((day     ) => DAY_LABELS[day]).join(", ")}`;
}

function slug(text     ) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "task";
}

function createLiveuiTaskVoice(deps      = {}) {
  const enabled = typeof deps.enabled === "function" ? deps.enabled : () => false;
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const newConfirmId = typeof deps.newConfirmId === "function"
    ? deps.newConfirmId
    : () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  function off() {
    return rejected("scheduled_tasks_off", "Scheduled Tasks are not turned on in the OcuClaw app. Do not retry.");
  }

  function readTask(taskId     ) {
    const loaded      = deps.readTask(taskId);
    return loaded && loaded.status === "accepted" ? loaded.task : null;
  }

  function taskRows() {
    const listed      = deps.listTasks();
    return listed && Array.isArray(listed.tasks) ? listed.tasks : [];
  }

  function freeTaskId(base     ) {
    const rows = taskRows();
    const taken = new Set(rows.map((row     ) => row.itemId || row.taskId));
    const stem = slug(base);
    if (!taken.has(stem) && TASK_ID_RE.test(stem)) return stem;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${stem}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${stem}-${newConfirmId()}`.slice(0, 64);
  }

  function freeName(base     ) {
    const names = new Set(taskRows().map((row     ) => String(row.name || "").trim().toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n += 1) {
      const candidate = `${base} ${n}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return base;
  }

  function listSchedules() {
    if (!enabled()) return off();
    const scheduler = deps.scheduler();
    const tasks = taskRows().map((row     ) => {
      const taskId = row.itemId || row.taskId;
      const read      = scheduler.read(taskId);
      const schedule = read && read.status === "accepted" ? read.schedule : null;
      return {
        taskId,
        name: row.name,
        when: schedule && schedule.approved ? schedule.approved.when : null,
        whenText: describeTaskWhen(schedule && schedule.approved ? schedule.approved.when : null),
        quiet: !!(schedule && schedule.approved && schedule.approved.popUp === false),
        pendingWhen: schedule && schedule.pending ? schedule.pending.when : null,
        state: schedule ? schedule.state : "unknown",
      };
    });
    return { status: "accepted", tasks };
  }

  async function scheduleTask(input     , context      = {}) {
    if (!enabled()) return off();
    const route      = classifyVoiceTaskRequest(input);
    if (route.status !== "accepted") return route;
    const scheduler = deps.scheduler();
    if (!keepsSchedules(scheduler)) return rejected("task_schedule_unsupported", "Scheduling a Task needs a host that keeps schedules");
    const profileId = context.agentId || "default";
    let request = "";
    let name = hasText(input.name) ? input.name.trim() : "";
    let starter      = null;
    let starterDescription = "";
    let kind = typeof input.kind === "string" ? input.kind : "brief";
    if (input.starter) {
      starter = { key: input.starter.key, slots: isPlainObject(input.starter.slots) ? input.starter.slots : {} };

      const filled      = await scheduler.fillStarter(starter, profileId);
      if (filled.status !== "ok") {
        return rejected(`task_starter_${filled.code || "failed"}`, "Hermes could not fill this starter");
      }
      request = filled.starter.prompt;
      starterDescription = typeof filled.starter.description === "string" ? filled.starter.description : "";
      const known = OCUCLAW_VOICE_STARTERS[starter.key];
      if (known) kind = known.kind;
      if (!name) name = filled.starter.title || (known && known.title) || starter.key;
    } else {
      request = input.request.trim();
      if (!name) return rejected("task_name_invalid", "a Task in the wearer's own words needs a name");
    }
    const plan      = validateTaskSchedulePlan({
      when: route.when,
      kind,
      ...(starter ? { starter } : {}),

      ...(input.monitorUrl !== undefined && input.monitorUrl !== null ? { monitorUrl: input.monitorUrl } : {}),
    });
    if (plan.status !== "accepted") return plan;

    const monitorRefused = taskMonitorRefusal(scheduler, plan.plan, ". Do not retry with monitorUrl.");
    if (monitorRefused) return monitorRefused;
    name = freeName(name);
    const taskId = hasText(input.taskId) ? input.taskId.trim() : freeTaskId(name);

    const description = taskShortDescription({
      starterDescription,
      request,
      whenText: describeTaskWhen(plan.plan.when),
    });
    const created      = deps.createDraft(
      { taskId, name, request, ...(description ? { description } : {}) },
      { agentId: context.agentId },
    );
    if (!created || created.status !== "saved") return created;
    const proposed      = scheduler.propose(taskId, plan.plan, {
      expectedDigest: created.task.digest,
      authoredBy: "agent",
    });
    if (proposed.status !== "saved") return proposed;
    const draft = { taskId, name, when: plan.plan.when, whenText: describeTaskWhen(plan.plan.when) };
    if (route.approval !== "glasses") {
      emit("task_voice_draft", { taskId, reason: route.reason });
      return {
        status: "saved",
        approval: "phone",
        reason: route.reason,
        ...draft,
        message: "Saved as a Draft. Tell the user to approve it on the phone; it does not run until then.",
      };
    }
    const confirmId = newConfirmId();
    const digest = readTask(taskId).digest;

    let resolveDecision                      ;
    const completed = new Promise     ((resolve) => { resolveDecision = resolve; });
    let settled = false;
    let outcome     ;
    const presented      = deps.presentConfirm({
      confirmId,
      sessionKey: context.sessionKey,
      title: "New Task",
      question: `Make "${name}" ${draft.whenText}?`,
      options: [
        { key: "make", label: "Make it", detail: `${name} runs ${draft.whenText} and shows on your glasses.` },
        { key: "cancel", label: "Not now", detail: "Nothing is made." },
      ],
      expiresAtMs: now() + CONFIRM_TTL_MS,
      onDecision: (decision     ) => {
        if (settled) return outcome;
        settled = true;
        try {
          outcome = settleConfirm(taskId, digest, plan.plan, decision);
        } catch (_) {
          outcome = rejected("task_review_failed", "Could not confirm the Task. Read its state before retrying.");
        }
        const approved = outcome?.status === "accepted" && decision?.choice === "make";
        const declined = outcome?.status === "accepted" && decision?.choice === "cancel" && decision?.reason === "selected";

        const { task: _taskSnapshot, ...decisionOutcome } = outcome ?? {};
        resolveDecision ({
          ...draft,
          ...decisionOutcome,
          ...(approved ? {
            status: "approved", approval: "glasses",
            message: "The user approved this Task on the glasses. No further approval is needed. Its schedule is being synchronized; do not create another Task.",
          } : declined ? {
            status: "cancelled", approval: "glasses", message: "The user chose Not now. Nothing was made.",
          } : outcome?.left === "draft" ? {
            status: "saved", approval: "phone",
            message: "The glasses confirmation ended without a choice. A Draft was retained on the phone.",
          } : {}),
        });
        return outcome;
      },
    });
    if (!presented || presented.presented !== true) {
      emit("task_voice_draft", { taskId, reason: "confirm_unavailable" });
      return {
        status: "saved",
        approval: "phone",
        reason: "confirm_unavailable",
        ...draft,
        message: "The glasses could not ask, so this waits as a Draft. Tell the user to approve it on the phone.",
      };
    }
    emit("task_voice_confirm_presented", { taskId, confirmId });
    return completed;
  }

  function settleConfirm(taskId     , digest     , plan     , decision     ) {
    const choice = decision && decision.choice;
    const reason = decision && decision.reason;
    const task = readTask(taskId);
    const read      = task ? deps.scheduler().read(taskId) : null;
    const pending = read && read.status === "accepted" ? read.schedule.pending : null;

    const unchanged = !!task && task.digest === digest && !!pending &&
      canonicalSerialize(pending) === canonicalSerialize(plan);
    if (choice === "make" && reason === "selected") {
      if (!unchanged) {
        emit("task_voice_confirm_stale", { taskId });
        return { status: "rejected", code: "task_voice_changed" };
      }
      const approved      = deps.reviewTask({ taskId, action: "approve", expectedDigest: digest });
      emit("task_voice_confirmed", { taskId, status: approved && approved.status });
      return approved;
    }
    if (choice === "cancel" && reason === "selected" && unchanged) {

      const removed      = deps.reviewTask({ taskId, action: "reject", expectedDigest: digest });
      emit("task_voice_declined", { taskId, status: removed && removed.status });
      return removed;
    }

    emit("task_voice_confirm_unanswered", { taskId, reason: reason || "unknown" });
    return { status: "accepted", left: "draft" };
  }

  function approvedPlan(taskId     ) {
    const read      = deps.scheduler().read(taskId);
    if (!read || read.status !== "accepted") return { error: read };
    if (!read.schedule.approved || !read.schedule.approved.when) {
      return { error: rejected("task_schedule_none", "This Task has no When to change") };
    }
    return { plan: read.schedule.approved };
  }

  async function lessen(action     , input      = {}) {
    if (!enabled()) return off();
    const taskId = input && typeof input.taskId === "string" ? input.taskId : "";
    const scheduler = deps.scheduler();
    if (action === "pause") return scheduler.pause(taskId);
    const current      = approvedPlan(taskId);
    if (current.error) return current.error;
    const plan = current.plan;
    let next     ;
    if (action === "stop") next = { ...plan, when: null };
    else if (action === "quiet") next = { ...plan, popUp: false };
    else if (action === "move") {
      const when      = validateTaskWhen(input.when);
      if (when.status !== "accepted" || !when.when) return rejected("task_when_invalid", "move needs a new when");
      next = { ...plan, when: when.when };
    } else {
      return rejected("task_operation_invalid", "unknown doing-less action");
    }
    const task = readTask(taskId);
    if (!task) return rejected("task_not_found", `task not found: ${taskId}`);
    const less = isTaskScheduleRelaxation(plan, next);
    const result      = await scheduler.set(taskId, next, { expectedDigest: task.digest, authoredBy: "agent" });

    if (!less && result && result.applied === "draft") {
      return {
        ...result,
        approval: "phone",
        message: "That is more than a move, so it waits as a Draft. Tell the user to approve it on the phone.",
      };
    }
    return result;
  }

  return { listSchedules, scheduleTask, lessen, settleConfirm };
}

module.exports = { OCUCLAW_VOICE_STARTERS, classifyVoiceTaskRequest, describeTaskWhen, createLiveuiTaskVoice };
