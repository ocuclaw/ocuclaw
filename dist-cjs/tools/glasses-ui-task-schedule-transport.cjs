const TASK_SCHEDULE_OPERATIONS = new Set([
  "taskSchedule.fillStarter",
  "taskSchedule.create",
  "taskSchedule.update",
  "taskSchedule.pause",
  "taskSchedule.resume",
  "taskSchedule.run",
  "taskSchedule.delete",
  "taskSchedule.status",

  "taskSchedule.foreign",
  "taskSchedule.adopt",

  "taskSchedule.test",
  "taskSchedule.testEnd",
]);
const TASK_SCHEDULE_READS = new Set(["taskSchedule.fillStarter", "taskSchedule.status", "taskSchedule.foreign"]);
const TASK_SCHEDULE_ERROR_CODES = new Set([
  "invalid_request",

  "invalid_scope",
  "native_read_failed",
  "profile_not_served",
  "unsupported",
  "job_missing",
  "job_not_owned",
  "job_owned",
  "job_no_prompt",
  "job_paused",

  "already_running",
  "run_not_started",
  "starter_missing",
  "starter_invalid",
  "starter_changed",
  "schedule_invalid",

  "page_watch_off",
  "page_watch_once",
  "outcome_unknown",
  "native_failed",
]);

const TASK_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PROFILE_RE = /^[A-Za-z0-9._-]{1,128}$/;

const MONITOR_URL_RE = /^https?:\/\/[!-~]{1,490}$/;

const hasOwn = (value     , key     ) => Object.prototype.hasOwnProperty.call(value, key);

function text(value     , max = 160) {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "";
}

function promptText(value     , max = 4000) {
  return typeof value === "string" && value.length <= max && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value)
    ? value
    : "";
}

function taskScheduleRequest(operation     , payload     ) {
  if (!TASK_SCHEDULE_OPERATIONS.has(operation)) return undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  if (operation === "taskSchedule.fillStarter") {
    return Object.keys(payload).length === 1 && payload.starter ? { starter: payload.starter } : undefined;
  }
  if (operation === "taskSchedule.foreign") {
    return Object.keys(payload).length === 1 && JOB_ID_RE.test(payload.jobId || "") ? { jobId: payload.jobId } : undefined;
  }
  if (!TASK_ID_RE.test(payload.taskId || "")) return undefined;
  const out      = { taskId: payload.taskId };
  if (operation === "taskSchedule.test") {
    for (const key of ["name", "request", "kind"]) {
      if (!hasOwn(payload, key) || payload[key] === null || payload[key] === undefined) return undefined;
      out[key] = payload[key];
    }
    if (payload.starter) out.starter = payload.starter;
    if (payload.look) out.look = payload.look;

    if (payload.openCard === true) out.openCard = true;
    if (payload.openCard === true && Array.isArray(payload.cardInputs)) out.cardInputs = payload.cardInputs;
    return out;
  }
  if (operation !== "taskSchedule.create") {
    if (!JOB_ID_RE.test(payload.jobId || "")) return undefined;
    out.jobId = payload.jobId;
  }
  if (operation === "taskSchedule.create" || operation === "taskSchedule.update") {
    for (const key of ["name", "request", "kind", "when"]) {
      if (!hasOwn(payload, key) || payload[key] === null || payload[key] === undefined) return undefined;
      out[key] = payload[key];
    }
    if (payload.starter) out.starter = payload.starter;
    if (typeof payload.monitorUrl === "string") out.monitorUrl = payload.monitorUrl;

    if (payload.look) out.look = payload.look;
  }

  if (operation === "taskSchedule.create" && JOB_ID_RE.test(payload.replacesJobId || "")) {
    out.replacesJobId = payload.replacesJobId;
  }
  if (operation === "taskSchedule.status" && payload.when) out.when = payload.when;
  return out;
}

function jobView(raw     ) {
  if (!raw || typeof raw !== "object" || !JOB_ID_RE.test(raw.id || "")) return null;
  const zone = raw.timeZone && typeof raw.timeZone === "object"
    ? {
        requested: text(raw.timeZone.requested, 64),
        host: text(raw.timeZone.host, 64),
        exact: raw.timeZone.exact === true,
      }
    : null;

  const watch      = {};
  if (typeof raw.monitorUrl === "string" && MONITOR_URL_RE.test(raw.monitorUrl)) watch.monitorUrl = raw.monitorUrl;
  if (text(raw.lastCheckAt, 64)) watch.lastCheckAt = raw.lastCheckAt;
  if (text(raw.checkError, 160)) watch.checkError = raw.checkError;
  return {
    id: raw.id,
    taskId: text(raw.taskId, 64),
    name: text(raw.name, 120),
    state: ["scheduled", "paused", "running", "completed", "error"].includes(raw.state) ? raw.state : "unknown",
    paused: raw.paused === true,
    schedule: text(raw.schedule),
    nextRunAt: text(raw.nextRunAt, 64),
    lastRunAt: text(raw.lastRunAt, 64),
    lastStatus: text(raw.lastStatus, 32),
    deliver: text(raw.deliver, 64),
    attachToSession: raw.attachToSession === true,
    scheduleDrift: raw.scheduleDrift === true,

    noModel: raw.noModel === true,
    monitored: raw.monitored === true,
    contextFrom: Array.isArray(raw.contextFrom)
      ? raw.contextFrom.filter((id     ) => typeof id === "string" && JOB_ID_RE.test(id)).slice(0, 16)
      : [],
    ...watch,
    ...(zone ? { timeZone: zone } : {}),
  };
}

function taskScheduleResult(identity     , raw     ) {
  if (!raw || typeof raw !== "object" ||
      ["requestId", "operation", "scope", "profileId"].some((key) => raw[key] !== identity[key])) {
    return { status: "error", code: TASK_SCHEDULE_READS.has(identity.operation) ? "response_identity_mismatch" : "outcome_unknown" };
  }
  if (raw.status === "unsupported") return { status: "unsupported", code: "unsupported" };
  if (raw.status !== "ok") {
    const code = TASK_SCHEDULE_ERROR_CODES.has(raw.errorCode) ? raw.errorCode
      : TASK_SCHEDULE_READS.has(identity.operation) ? "native_failed" : "outcome_unknown";
    const failed      = { status: "error", code };
    const starterPrompt = raw.taskSchedule && promptText(raw.taskSchedule.starterPrompt);
    if (code === "starter_changed" && starterPrompt) failed.starterPrompt = starterPrompt;
    return failed;
  }
  const data = raw.taskSchedule && typeof raw.taskSchedule === "object" ? raw.taskSchedule : {};
  if (identity.operation === "taskSchedule.fillStarter") {
    const starter = data.starter && typeof data.starter === "object" ? data.starter : null;
    const prompt = starter && promptText(starter.prompt);
    if (!prompt) return { status: "error", code: "native_failed" };
    return {
      status: "ok",
      starter: {
        key: text(starter.key, 128),
        title: text(starter.title, 120),

        description: text(starter.description, 300),
        prompt,
        schedule: text(starter.schedule),
        skills: Array.isArray(starter.skills) ? starter.skills.map((skill     ) => text(skill, 80)).filter(Boolean).slice(0, 16) : [],
      },
    };
  }
  if (identity.operation === "taskSchedule.foreign") {

    const raw = data.job && typeof data.job === "object" ? data.job : null;
    const prompt = raw && promptText(raw.prompt);
    if (!raw || raw.id !== identity.taskSchedule.jobId || !prompt || !prompt.trim()) {
      return { status: "error", code: "native_failed" };
    }

    const monitorUrl = typeof raw.monitorUrl === "string" && MONITOR_URL_RE.test(raw.monitorUrl) ? raw.monitorUrl : null;
    return { status: "ok", job: { id: raw.id, name: text(raw.name, 120), prompt, ...(monitorUrl ? { monitorUrl } : {}) } };
  }
  if (identity.operation === "taskSchedule.test") {
    const id = data.job && typeof data.job === "object" && JOB_ID_RE.test(data.job.id || "") ? data.job.id : null;
    return id ? { status: "ok", job: { id } } : { status: "error", code: "outcome_unknown" };
  }
  if (identity.operation === "taskSchedule.delete" || identity.operation === "taskSchedule.testEnd") {
    return { status: "ok", deleted: data.deleted === true, jobMissing: data.jobMissing === true };
  }
  const job = jobView(data.job);
  if (!job || (identity.operation !== "taskSchedule.create" && job.id !== identity.taskSchedule.jobId)) {
    return { status: "error", code: TASK_SCHEDULE_READS.has(identity.operation) ? "native_failed" : "outcome_unknown" };
  }
  return { status: "ok", job, ...(data.adopted === true ? { adopted: true } : {}) };
}

function createTaskScheduleTransport(opts      = {}) {
  const request = typeof opts.request === "function" ? opts.request : null;
  const newRequestId = typeof opts.newRequestId === "function"
    ? opts.newRequestId
    : () => `task-schedule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const ready = typeof opts.available === "function" ? opts.available : () => true;
  const available = () => {
    if (!request) return false;
    try {
      return ready() === true;
    } catch (_) {
      return false;
    }
  };
  return {
    get available() {
      return available();
    },
    async call(operation     , profileId     , payload     ) {
      if (!available()) return { status: "unsupported", code: "unsupported" };
      const shaped = taskScheduleRequest(operation, payload);
      if (!shaped || !PROFILE_RE.test(profileId || "")) return { status: "error", code: "invalid_request" };
      const identity = {
        requestId: newRequestId(),
        operation,
        scope: "profile",
        profileId,
        taskSchedule: shaped,
      };
      try {
        return taskScheduleResult(identity, await request(identity));
      } catch (err     ) {
        if (err && (err.code === -32601 || err.code === "capability_unavailable")) {
          return { status: "unsupported", code: "unsupported" };
        }
        return { status: "error", code: TASK_SCHEDULE_READS.has(operation) ? "management_unavailable" : "outcome_unknown" };
      }
    },
  };
}

module.exports = { TASK_SCHEDULE_OPERATIONS, TASK_SCHEDULE_READS, TASK_SCHEDULE_ERROR_CODES, taskScheduleRequest, taskScheduleResult, createTaskScheduleTransport };
