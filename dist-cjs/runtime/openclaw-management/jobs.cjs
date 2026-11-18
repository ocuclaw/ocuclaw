const { createHash } = require("node:crypto");
const { OpenClawManagementError } = require("./shared.cjs");
const { listOpenClawStarters } = require("../openclaw-task-starters.cjs");
const { starterRows } = require("../hermes-starter-kinds.cjs");

const READS = new Set(["jobs.list", "jobs.history", "jobs.receipt"]);
const WRITES = new Set(["jobs.pause", "jobs.resume", "jobs.run"]);
const JOB_LIMIT = 100;
const HISTORY_LIMIT = 50;
const RECEIPT_LIMIT = 200;
const RECEIPTS = Symbol.for("ocuclaw.openclaw-management.jobs.receipts");
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

const SYSTEM_MONITOR_PREFIXES = ["heartbeat:", "skill-collection-review:"];

function receipts() {
  const holder      = globalThis;
  if (!(holder[RECEIPTS] instanceof Map)) holder[RECEIPTS] = new Map();
  return holder[RECEIPTS];
}

function remember(key     , record     ) {
  const store = receipts();
  store.delete(key);
  store.set(key, record);
  while (store.size > RECEIPT_LIMIT) store.delete(store.keys().next().value);
}

function text(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value     ) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(ms     ) {
  return finite(ms) === null ? "" : new Date(ms).toISOString();
}

function executionToken(runId     ) {
  return text(runId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

function isSystemMonitor(job     ) {
  const key = text(job?.declarationKey);
  return SYSTEM_MONITOR_PREFIXES.some(prefix => key.startsWith(prefix));
}

function listedFor(job     , profileId     ) {
  if (!job || typeof job !== "object" || !TOKEN.test(text(job.id)) || isSystemMonitor(job)) return false;
  const owner = text(job.effectiveAgentId) || text(job.agentId);
  return !owner || owner === profileId;
}

function scheduleText(schedule     , timeZone     ) {
  if (!schedule || typeof schedule !== "object") return "";
  if (schedule.kind === "cron") return text(schedule.expr);
  if (schedule.kind === "every") {
    const everyMs = finite(schedule.everyMs);
    if (everyMs === null || everyMs <= 0) return "";
    const minutes = Math.max(1, Math.ceil(everyMs / 60000));
    if (minutes % 1440 === 0) return `every ${minutes / 1440}d`;
    return minutes % 60 === 0 ? `every ${minutes / 60}h` : `every ${minutes}m`;
  }
  if (schedule.kind === "at") return localMoment(Date.parse(text(schedule.at)), timeZone);
  return "";
}

function localMoment(ms     , timeZone     ) {
  if (finite(ms) === null) return "";
  try {
    const parts      = {};
    const format = new Intl.DateTimeFormat("en-CA", { timeZone: timeZone || undefined, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    for (const part of format.formatToParts(new Date(ms))) parts[part.type] = part.value;
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return "";
  }
}

function runStatus(status     ) {
  if (status === "ok") return "completed";
  if (status === "error") return "failed";
  return "unknown";
}

function deliveryStatus(status     , suppression     ) {
  if (text(suppression)) return "suppressed";
  if (status === "delivered") return "delivered";
  if (status === "not-delivered") return "failed";
  if (status === "not-requested") return "not_configured";
  return "unknown";
}

function field(job     , key     ) {
  return job?.[key] ?? job?.state?.[key];
}

function lastExecution(job     ) {
  const runningAt = finite(job?.state?.runningAtMs);
  if (runningAt !== null) {
    return { id: "", jobId: job.id, status: "running", delivery: "unknown", startedAt: iso(runningAt), finishedAt: "" };
  }
  const lastAt = finite(field(job, "lastRunAtMs"));
  if (lastAt === null) return null;
  const duration = finite(field(job, "lastDurationMs"));
  return {
    id: "",
    jobId: job.id,
    status: runStatus(field(job, "lastRunStatus") ?? field(job, "lastStatus")),
    delivery: deliveryStatus(field(job, "lastDeliveryStatus"), field(job, "deliverySuppressionReason")),
    startedAt: iso(lastAt),
    finishedAt: duration === null ? "" : iso(lastAt + duration),
  };
}

function jobRow(job     , timeZone     ) {
  const enabled = job.enabled !== false;
  const running = finite(job?.state?.runningAtMs) !== null;

  const done = job.schedule?.kind === "at" && !enabled && finite(field(job, "lastRunAtMs")) !== null;
  return {
    id: job.id,
    name: text(job.displayName) || text(job.name) || job.id,
    state: running ? "running" : done ? "completed" : enabled ? "scheduled" : "paused",
    paused: !enabled && !done,
    schedule: scheduleText(job.schedule, timeZone),
    nextRunAt: enabled ? iso(field(job, "nextRunAtMs")) : "",
    lastExecution: lastExecution(job),
  };
}

function runEntry(entry     ) {
  const id = executionToken(entry?.runId) || executionToken(`${text(entry?.jobId)}-${finite(entry?.ts) ?? ""}`);
  return {
    id,
    jobId: text(entry?.jobId),
    status: entry?.action === "started" ? "running" : runStatus(entry?.status),
    delivery: deliveryStatus(entry?.deliveryStatus, entry?.deliverySuppressionReason),
    startedAt: iso(entry?.runAtMs),
    finishedAt: entry?.action === "started" ? "" : iso(entry?.ts),
  };
}

function hostTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

async function listedJobs(ctx     , profileId     ) {
  const page      = await ctx.call("cron.list", {
    includeDisabled: true, agentId: profileId, limit: 200, includeDeliveryPreviews: false,
  });
  const rows = (Array.isArray(page?.jobs) ? page.jobs : []).filter((job     ) => listedFor(job, profileId));
  return { rows, truncated: rows.length > JOB_LIMIT || page?.hasMore === true };
}

async function agentJobIds(ctx     , profileId     ) {
  return new Set((await listedJobs(ctx, profileId)).rows.map((job     ) => job.id));
}

async function snapshot(ctx     , profileId     , jobId     ) {
  const zone = hostTimeZone();
  const { rows, truncated } = await listedJobs(ctx, profileId);
  const listed = rows.slice(0, JOB_LIMIT);
  const ids = new Set(listed.map((job     ) => job.id));
  let history      = [];
  if (ctx.advertises("cron.runs") && (!jobId || ids.has(jobId))) {
    const page      = await ctx.call("cron.runs", jobId
      ? { id: jobId, limit: HISTORY_LIMIT, sortDir: "desc" }
      : { scope: "all", agentId: profileId, limit: HISTORY_LIMIT, sortDir: "desc" });
    history = (Array.isArray(page?.entries) ? page.entries : [])
      .filter((entry     ) => ids.has(entry?.jobId)).map(runEntry);
  }
  return { provider: "OpenClaw", jobs: listed.map((job     ) => jobRow(job, zone)), history, truncated };
}

async function jobsSummary(ctx     , profileId     ) {
  if (!ctx.advertises("cron.list")) return null;
  try {
    const { rows, truncated } = await listedJobs(ctx, profileId);
    if (truncated || rows.length >= JOB_LIMIT) return null;
    const now = Date.now();
    const next = rows.filter((job     ) => job.enabled !== false)
      .map((job     ) => finite(field(job, "nextRunAtMs"))).filter((ms     ) => ms !== null && ms >= now);
    const summary      = { jobs: rows.length };
    if (next.length > 0) summary.nextJobAtMs = Math.min(...next);
    return summary;
  } catch {
    return null;
  }
}

const hostCodeOf = (error     ) => error?.hostCode || "";

async function currentJob(ctx     , profileId     , jobId     ) {
  try {
    const job      = await ctx.call("cron.get", { id: jobId });
    return listedFor(job, profileId) ? job : null;
  } catch (error     ) {

    if (error?.hostCode === "INVALID_REQUEST") return null;
    throw error;
  }
}

function receiptBody(record     ) {
  const receipt      = {
    operationId: record.operationId,
    jobId: record.jobId,
    state: record.state,
    jobPresence: record.jobPresence || "unknown",
  };
  if (record.executionId) {
    receipt.executionId = record.executionId;
    receipt.execution = { ...record.execution, id: record.executionId, jobId: record.jobId };
  }
  if (record.job && record.job.id === record.jobId) receipt.job = record.job;
  return { status: "ok", jobs: { receipt } };
}

async function refresh(ctx     , record     ) {
  const settledRun = record.execution && ["completed", "failed"].includes(record.execution.status);
  if (!["admitted", "unknown"].includes(record.state) || settledRun) return;
  const job = await currentJob(ctx, record.profileId, record.jobId).catch(() => undefined);
  if (job === undefined) return;
  if (job === null) {
    record.jobPresence = "removed";
    record.job = null;
    return;
  }
  const zone = hostTimeZone();
  record.jobPresence = "present";
  record.job = jobRow(job, zone);
  if (record.state === "unknown" && record.operation !== "jobs.run" && (job.enabled !== false) === record.enable) {
    record.state = "applied";
    return;
  }
  if (record.state !== "admitted" || !record.runId || !ctx.advertises("cron.runs")) return;
  try {
    const page      = await ctx.call("cron.runs", { id: record.jobId, runId: record.runId, limit: 5 });
    const entries = (Array.isArray(page?.entries) ? page.entries : []).filter((entry     ) => entry?.runId === record.runId);
    const finished = entries.find((entry     ) => entry?.action !== "started");
    if (finished) record.execution = runEntry(finished);
  } catch {

  }
}

function fingerprint(request     ) {
  const p = request.jobs || {};
  return `${request.operation}|${p.jobId}|${p.resumeAndRun === true}`;
}

async function mutate(ctx     , request     ) {
  const p = request.jobs || {};
  const key = `${request.profileId}:${p.operationId}`;
  const store = receipts();
  const previous = store.get(key);
  if (previous) {

    if (previous.state !== "cancelled" && previous.fingerprint !== fingerprint(request)) {
      return { status: "error", errorCode: "invalid_request" };
    }
    await refresh(ctx, previous);
    return receiptBody(previous);
  }
  const record      = {
    operationId: p.operationId, profileId: request.profileId, operation: request.operation, jobId: p.jobId,
    fingerprint: fingerprint(request), state: "reserved", jobPresence: "unknown",
    enable: request.operation === "jobs.resume",
  };
  remember(key, record);
  const zone = hostTimeZone();
  try {
    const job = await currentJob(ctx, request.profileId, p.jobId);
    if (!job) {
      Object.assign(record, { state: "rejected", jobPresence: "removed" });
      return receiptBody(record);
    }
    record.jobPresence = "present";
    if (request.operation !== "jobs.run") {
      const updated      = await ctx.call("cron.update", { id: p.jobId, patch: { enabled: record.enable } });
      Object.assign(record, { state: "applied", job: jobRow(updated?.id === p.jobId ? updated : { ...job, enabled: record.enable }, zone) });
      return receiptBody(record);
    }
    if (p.resumeAndRun === true && job.enabled === false) {
      record.enable = true;
      const resumed      = await ctx.call("cron.update", { id: p.jobId, patch: { enabled: true } });
      record.job = jobRow(resumed?.id === p.jobId ? resumed : { ...job, enabled: true }, zone);
    }
    const run      = await ctx.call("cron.run", { id: p.jobId });
    if (run?.ok !== true || run?.enqueued !== true || !executionToken(run?.runId)) {

      record.state = "rejected";
      return receiptBody(record);
    }
    Object.assign(record, {
      state: "admitted", runId: text(run.runId), executionId: executionToken(run.runId),
      execution: { status: "running", delivery: "unknown", startedAt: iso(Date.now()), finishedAt: "" },
    });
    return receiptBody(record);
  } catch (error     ) {
    if (!(error instanceof OpenClawManagementError)) throw error;

    if (hostCodeOf(error) === "INVALID_REQUEST" || error.code === "rate_limited") {
      record.state = "rejected";
      return receiptBody(record);
    }
    if (error.code === "unsupported") {
      record.state = "rejected";
      throw error;
    }
    record.state = "unknown";
    throw new OpenClawManagementError("management_unavailable");
  }
}

function cancel(request     ) {
  const p = request.jobs || {};
  const key = `${request.profileId}:${p.operationId}`;
  const previous = receipts().get(key);
  if (previous) return receiptBody(previous);
  const record = { operationId: p.operationId, profileId: request.profileId, operation: "jobs.cancel", jobId: p.jobId,
    fingerprint: "", state: "cancelled", jobPresence: "unknown" };
  remember(key, record);
  return receiptBody(record);
}

async function receipt(ctx     , request     ) {
  const operationId = request.jobs?.operationId;
  const record = receipts().get(`${request.profileId}:${operationId}`);
  if (!record) return { status: "ok", jobs: { receipt: { operationId, jobId: "", state: "not_found", jobPresence: "unknown" } } };
  await refresh(ctx, record);
  return receiptBody(record);
}

const EDITOR_READS = new Set(["automations.options", "automations.read", "automations.preview", "automations.receipt",
  "automations.starters"]);
const EDITOR_WRITES = new Set(["automations.create", "automations.update", "automations.delete"]);
const EDITOR_FIELDS = new Set(["name", "prompt", "schedule", "deliver", "model"]);
const NEW_JOB = "new";
const HASH = /^[a-f0-9]{64}$/;

function sha256(value     ) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function revisionOf(job     ) {
  return sha256(text(job?.configRevision) || JSON.stringify({ schedule: job?.schedule, payload: job?.payload,
    delivery: job?.delivery, name: job?.name, enabled: job?.enabled }));
}

const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const CRON_NAMES      = [null, null, null,
  { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }];

function cronValue(raw     , index     ) {
  const named = CRON_NAMES[index]?.[raw.toLowerCase()];
  if (named !== undefined) return named;
  return /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
}

function cronField(raw     , index     ) {
  const [min, max] = CRON_RANGES[index];
  const values = new Set();
  for (const part of raw.split(",")) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    let low = min;
    let high = max;
    if (match[1] !== "*") {
      const [from, to] = match[1].split("-");
      low = cronValue(from, index);
      high = to === undefined ? (match[2] === undefined ? low : max) : cronValue(to, index);
    }
    if (!Number.isInteger(low) || !Number.isInteger(high) || step < 1 || low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) values.add(index === 4 && value === 7 ? 0 : value);
  }
  return values;
}

function parseCron(expr     ) {
  const parts = text(expr).split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((part     , index     ) => cronField(part, index));
  if (fields.some((field     ) => field === null)) return null;
  return { minutes: fields[0], hours: fields[1], days: fields[2], months: fields[3], weekdays: fields[4],
    anyDay: parts[2] === "*", anyWeekday: parts[4] === "*" };
}

function zoneParts(ms     , timeZone     ) {
  const parts      = {};
  const format = new Intl.DateTimeFormat("en-US", { timeZone: timeZone || undefined, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  for (const part of format.formatToParts(new Date(ms))) parts[part.type] = Number(part.value);
  return parts;
}

function zonedMs(year     , month     , day     , hour     , minute     , timeZone     ) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 2; i += 1) {
    const seen = zoneParts(guess, timeZone);
    const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - guess;
    guess = wall - offset;
  }
  return guess;
}

function nextCronRun(expr     , timeZone     , fromMs     ) {
  const cron      = parseCron(expr);
  if (!cron) return null;
  try {
    const start = zoneParts(fromMs, timeZone);
    const hours = [...cron.hours].sort((a     , b     ) => a - b);
    const minutes = [...cron.minutes].sort((a     , b     ) => a - b);
    for (let offset = 0; offset <= 366 * 5; offset += 1) {
      const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
      const [year, month, day, weekday] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCDay()];
      if (!cron.months.has(month)) continue;
      const dom = cron.days.has(day);
      const dow = cron.weekdays.has(weekday);

      if (!(cron.anyDay && cron.anyWeekday ? true : cron.anyDay ? dow : cron.anyWeekday ? dom : dom || dow)) continue;
      for (const hour of hours) {
        for (const minute of minutes) {
          const at = zonedMs(year, month, day, hour, minute, timeZone);
          const seen = zoneParts(at, timeZone);
          if (seen.hour !== hour || seen.minute !== minute) continue;
          if (at > fromMs) return at;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function parseSchedule(raw     , timeZone     , previous     ) {
  const value = text(raw);
  const every = /^every\s+(\d{1,5})\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(value);
  if (every) {
    const count = Number(every[1]);
    const unit = every[2].toLowerCase()[0];
    if (count < 1) return null;
    return { kind: "every", everyMs: count * (unit === "d" ? 86400000 : unit === "h" ? 3600000 : 60000) };
  }
  const once = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::00)?$/.exec(value);
  if (once) {
    const [year, month, day, hour, minute] = once.slice(1).map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    return { kind: "at", at: new Date(zonedMs(year, month, day, hour, minute, timeZone)).toISOString() };
  }
  if (!parseCron(value)) return null;
  const schedule      = { kind: "cron", expr: value };

  if (previous?.kind === "cron" && text(previous.tz)) schedule.tz = previous.tz;
  return schedule;
}

function scheduleZone(schedule     , hostZone     ) {
  return schedule?.kind === "cron" && text(schedule.tz) ? text(schedule.tz) : hostZone;
}

function nextRunOf(schedule     , hostZone     , now     ) {
  if (schedule?.kind === "every") return now + schedule.everyMs;
  if (schedule?.kind === "at") {
    const at = Date.parse(schedule.at);
    return Number.isFinite(at) && at > now ? at : null;
  }
  if (schedule?.kind === "cron") return nextCronRun(schedule.expr, scheduleZone(schedule, hostZone), now);
  return null;
}

function deliverOf(delivery     ) {
  if (!delivery || delivery.mode === "none") return "local";
  if (delivery.mode === "announce" && (!text(delivery.channel) || delivery.channel === "last") && !text(delivery.to)) return "last";
  return "custom";
}

function deliveryFor(deliver     ) {
  if (deliver === "local") return { mode: "none" };
  if (deliver === "last") return { mode: "announce", channel: "last" };
  return null;
}

function editorFields(job     , hostZone     ) {
  if (text(job?.declarationKey)) return null;

  if (text(job?.description).startsWith("ocuclaw-task:")) return null;
  if (!["cron", "every", "at"].includes(job?.schedule?.kind)) return null;
  const payload = job?.payload;
  if (payload?.kind !== "agentTurn" && payload?.kind !== "systemEvent") return null;
  const fields      = {
    name: text(job.displayName) || text(job.name),
    prompt: typeof (payload.kind === "agentTurn" ? payload.message : payload.text) === "string"
      ? (payload.kind === "agentTurn" ? payload.message : payload.text) : "",
    schedule: scheduleText(job.schedule, scheduleZone(job.schedule, hostZone)),
    deliver: deliverOf(job.delivery),
  };
  if (payload.kind === "agentTurn") fields.model = text(payload.model);
  return fields;
}

function editorJob(job     , hostZone     ) {
  const fields = editorFields(job, hostZone);
  if (!fields) return null;
  return { id: job.id, revision: revisionOf(job), fields, skills: [],
    nextRunAt: job.enabled === false ? "" : iso(field(job, "nextRunAtMs")), timezone: scheduleZone(job.schedule, hostZone) };
}

class EditorRefusal extends Error {
  code     ;

  constructor(code     ) {
    super(code);
    this.code = code;
  }
}

function editPlan(request     , current     , hostZone     ) {
  const p = request.automations || {};
  if (p.template !== undefined || p.templateValues !== undefined) throw new EditorRefusal("invalid_fields");
  const sent = p.fields || {};
  for (const [key, value] of Object.entries(sent)) {
    if (!EDITOR_FIELDS.has(key) || (value !== null && typeof value !== "string")) throw new EditorRefusal("invalid_fields");
  }
  const before = current ? editorFields(current, hostZone) : { name: "", prompt: "", schedule: "", deliver: "local", model: "" };
  if (!before) throw new EditorRefusal("not_editable");
  const after      = { ...before };
  for (const [key, value] of Object.entries(sent)) after[key] = value === null ? "" : text(value);
  if (current?.payload?.kind === "systemEvent" && after.model) throw new EditorRefusal("invalid_fields");
  const prompt = typeof sent.prompt === "string" ? sent.prompt : before.prompt;
  if (!text(prompt)) throw new EditorRefusal("invalid_fields");
  const schedule = parseSchedule(after.schedule, hostZone, current?.schedule);
  if (!schedule) throw new EditorRefusal("invalid_fields");

  const keepsCustom = after.deliver === "custom" && before.deliver === "custom" && current !== null;
  const delivery = keepsCustom ? null : deliveryFor(after.deliver);
  if (!delivery && !keepsCustom) throw new EditorRefusal("missing_destination");
  const name = after.name || text(prompt).split("\n")[0].slice(0, 60);
  if (!current) {
    const params      = {
      name, agentId: request.profileId, enabled: true, schedule, sessionTarget: "isolated", wakeMode: "now",
      payload: { kind: "agentTurn", message: prompt, ...(after.model ? { model: after.model } : {}) }, delivery,
    };
    return { fields: { ...after, name }, schedule, params };
  }
  const patch      = {};
  if ("name" in sent) {
    patch.name = name;
    if (text(current.displayName)) patch.displayName = null;
  }
  if ("schedule" in sent) patch.schedule = schedule;
  if ("deliver" in sent && delivery) patch.delivery = delivery;
  if ("prompt" in sent || "model" in sent) {
    patch.payload = current.payload.kind === "agentTurn"
      ? { kind: "agentTurn", ...("prompt" in sent ? { message: prompt } : {}), ...("model" in sent ? { model: after.model || null } : {}) }
      : { kind: "systemEvent", text: prompt };
  }
  return { fields: { ...after, name }, schedule, params: { id: current.id, patch } };
}

function reviewHashOf(request     , plan     ) {
  const p = request.automations || {};
  return sha256({ operation: request.operation, profileId: request.profileId, jobId: p.jobId || NEW_JOB,
    revision: p.revision || "", params: plan.params });
}

async function editorRead(ctx     , profileId     , jobId     ) {
  const job = await currentJob(ctx, profileId, jobId);

  if (!job) throw new EditorRefusal("stale_edit");
  return job;
}

function automationsReceiptBody(record     ) {
  const receipt      = {
    operationId: record.operationId, jobId: record.jobId, state: record.state,
    registration: record.registration || "not_attempted", jobPresence: record.jobPresence || "unknown",
  };
  if (record.job && record.job.id === record.jobId) receipt.job = record.job;
  return { status: "ok", automations: { receipt } };
}

async function editorWrite(ctx     , request     ) {
  const p = request.automations || {};
  const key = `automations:${request.profileId}:${p.operationId}`;
  const previous = receipts().get(key);
  const print = sha256({ operation: request.operation, jobId: p.jobId || "", revision: p.revision || "", fields: p.fields || null,
    reviewHash: p.reviewHash || "" });
  if (previous) {
    if (previous.state !== "cancelled" && previous.fingerprint !== print) return { status: "error", errorCode: "invalid_request" };
    return automationsReceiptBody(previous);
  }
  const record      = { operationId: p.operationId, jobId: p.jobId || NEW_JOB, state: "reserved", fingerprint: print,
    jobPresence: "unknown" };
  remember(key, record);
  const zone = hostTimeZone();
  try {
    let current      = null;
    if (request.operation !== "automations.create") {
      current = await currentJob(ctx, request.profileId, p.jobId);
      if (!current) return automationsReceiptBody(Object.assign(record, { state: "missing_job", jobPresence: "removed" }));
      record.jobPresence = "present";
      if (revisionOf(current) !== p.revision) {
        return automationsReceiptBody(Object.assign(record, { state: "stale_edit", job: editorJob(current, zone) }));
      }
    }
    if (request.operation === "automations.delete") {
      if (!editorFields(current, zone)) return automationsReceiptBody(Object.assign(record, { state: "rejected" }));
      await ctx.call("cron.remove", { id: p.jobId });
      return automationsReceiptBody(Object.assign(record, { state: "deleted", jobPresence: "removed" }));
    }
    let plan     ;
    try {
      plan = editPlan(request, current, zone);
    } catch (error     ) {
      if (!(error instanceof EditorRefusal)) throw error;
      return automationsReceiptBody(Object.assign(record, { state: "rejected" }));
    }

    if (reviewHashOf({ ...request, operation: "automations.preview" }, plan) !== p.reviewHash) {
      return automationsReceiptBody(Object.assign(record, { state: "rejected" }));
    }
    const saved      = current
      ? await ctx.call("cron.update", { ...plan.params, expectedConfigRevision: text(current.configRevision) || undefined })
      : await ctx.call("cron.add", plan.params);
    const job = saved && typeof saved === "object" && TOKEN.test(text(saved.id)) ? saved : null;
    if (!job) {
      record.state = "unknown";
      throw new OpenClawManagementError("management_unavailable");
    }
    return automationsReceiptBody(Object.assign(record, {
      jobId: job.id, state: "saved", jobPresence: "present", job: editorJob(job, zone),
      registration: job.enabled === false || finite(field(job, "nextRunAtMs")) !== null ? "registered" : "failed",
    }));
  } catch (error     ) {
    if (!(error instanceof OpenClawManagementError)) throw error;
    if (error.code === "config_changed") return automationsReceiptBody(Object.assign(record, { state: "stale_edit" }));
    if (hostCodeOf(error) === "INVALID_REQUEST" || error.code === "rate_limited") {
      return automationsReceiptBody(Object.assign(record, { state: "rejected" }));
    }
    if (record.state === "reserved") record.state = "unknown";
    if (error.code === "unsupported") throw error;
    throw new OpenClawManagementError("management_unavailable");
  }
}

async function editor(ctx     , request     ) {
  const p = request.automations || {};
  const zone = hostTimeZone();
  try {
    switch (request.operation) {
      case "automations.options":
        return { status: "ok", automations: { options: {
          timezone: zone,
          destinations: [
            { id: "local", name: "Keep in OpenClaw", available: true },
            { id: "last", name: "Last chat", available: true },
            { id: "custom", name: "As set on OpenClaw", available: true },
          ],
          advanced: [{ field: "model", supported: true }, { field: "provider", supported: false },
            { field: "enabled_toolsets", supported: false }, { field: "context_from", supported: false }],
          templates: [],
        } } };

      case "automations.starters":
        return { status: "ok", automations: { starters: ctx.taskSchedulesAvailable?.() === true
          ? starterRows(listOpenClawStarters()) : [] } };
      case "automations.read": {
        const job = editorJob(await editorRead(ctx, request.profileId, p.jobId), zone);
        return job ? { status: "ok", automations: { job } } : { status: "error", errorCode: "not_editable" };
      }
      case "automations.preview": {
        const current = p.jobId ? await editorRead(ctx, request.profileId, p.jobId) : null;
        if (current && revisionOf(current) !== p.revision) return { status: "error", errorCode: "stale_edit" };
        const plan = editPlan(request, current, zone);
        const preview      = { id: current ? current.id : NEW_JOB, revision: current ? revisionOf(current) : sha256(NEW_JOB),
          fields: plan.fields, skills: [], timezone: scheduleZone(plan.schedule, zone),
          nextRunAt: iso(nextRunOf(plan.schedule, zone, Date.now())), reviewHash: reviewHashOf(request, plan) };
        return { status: "ok", automations: { preview } };
      }
      case "automations.receipt": {
        const record = receipts().get(`automations:${request.profileId}:${p.operationId}`);
        if (!record) return { status: "ok", automations: { receipt: { operationId: p.operationId, jobId: "", state: "not_found",
          registration: "not_attempted", jobPresence: "unknown" } } };
        return automationsReceiptBody(record);
      }
      case "automations.cancel": {
        const key = `automations:${request.profileId}:${p.operationId}`;
        const previous = receipts().get(key);
        if (previous) return automationsReceiptBody(previous);
        const record = { operationId: p.operationId, jobId: "", state: "cancelled", fingerprint: "", jobPresence: "unknown" };
        remember(key, record);
        return automationsReceiptBody(record);
      }
      default:
        return editorWrite(ctx, request);
    }
  } catch (error     ) {
    if (error instanceof EditorRefusal) return { status: "error", errorCode: error.code };
    throw error;
  }
}

const anyWrite = (ctx     ) => [...WRITES].some(operation => jobsSection.supports(ctx, operation));
const anyEditorWrite = (ctx     ) => [...EDITOR_WRITES].some(operation => jobsSection.supports(ctx, operation));

const jobsSection      = {
  id: "jobs",
  operations: [
    { operation: "jobs.list", scope: "profile" },
    { operation: "jobs.history", scope: "profile" },
    { operation: "jobs.receipt", scope: "profile" },
    { operation: "jobs.pause", scope: "profile" },
    { operation: "jobs.resume", scope: "profile" },
    { operation: "jobs.run", scope: "profile" },
    { operation: "jobs.cancel", scope: "profile" },
    { operation: "automations.options", scope: "profile" },
    { operation: "automations.read", scope: "profile" },
    { operation: "automations.preview", scope: "profile" },
    { operation: "automations.receipt", scope: "profile" },
    { operation: "automations.create", scope: "profile" },
    { operation: "automations.update", scope: "profile" },
    { operation: "automations.delete", scope: "profile" },
    { operation: "automations.cancel", scope: "profile" },
    { operation: "automations.starters", scope: "profile" },

    { operation: "tasks.schedule", scope: "profile" },

    { operation: "tasks.watchPage", scope: "profile" },

    { operation: "tasks.test", scope: "profile" },
  ],
  supports(ctx     , operation     ) {

    if (operation === "automations.starters") return true;
    if (operation === "tasks.schedule") return ctx.taskSchedulesAvailable?.() === true;
    if (operation === "tasks.watchPage") return ctx.taskPagesWatched?.() === true;

    if (operation === "tasks.test") return ctx.taskSchedulesAvailable?.() === true;
    if (!ctx.advertises("cron.list")) return false;
    switch (operation) {
      case "jobs.list": return true;
      case "jobs.history": return ctx.advertises("cron.runs");
      case "jobs.pause":
      case "jobs.resume": return ctx.advertisesAll("cron.get", "cron.update");

      case "jobs.run": return ctx.advertisesAll("cron.get", "cron.update", "cron.run");
      case "jobs.receipt":
      case "jobs.cancel": return anyWrite(ctx);
      case "automations.options":
      case "automations.read":
      case "automations.preview": return ctx.advertises("cron.get");
      case "automations.create": return ctx.advertises("cron.add");
      case "automations.update": return ctx.advertisesAll("cron.get", "cron.update");
      case "automations.delete": return ctx.advertisesAll("cron.get", "cron.remove");
      case "automations.receipt":
      case "automations.cancel": return anyEditorWrite(ctx);
      default: return false;
    }
  },
  applyTiming(_ctx     , operation     ) {
    return READS.has(operation) || EDITOR_READS.has(operation) || operation === "tasks.schedule" ||
      operation === "tasks.watchPage" || operation === "tasks.test" ? "read_only" : "active_now";
  },
  async handle(env     , request     ) {
    const { ctx } = env;
    if (!ctx.connected()) throw new OpenClawManagementError("management_unavailable");
    const agents = await env.agents();
    if (!agents.some((row     ) => row.id === request.profileId)) return { status: "error", errorCode: "profile_not_served" };
    switch (request.operation) {
      case "jobs.list": return { status: "ok", jobs: await snapshot(ctx, request.profileId, null) };
      case "jobs.history": return { status: "ok", jobs: await snapshot(ctx, request.profileId, request.jobs?.jobId) };
      case "jobs.receipt": return receipt(ctx, request);
      case "jobs.cancel": return cancel(request);
      case "jobs.pause":
      case "jobs.resume":
      case "jobs.run": return mutate(ctx, request);

      case "tasks.schedule":
      case "tasks.watchPage":
      case "tasks.test": return { status: "error", errorCode: "invalid_request" };
      default: return editor(ctx, request);
    }
  },
};

module.exports = { executionToken, scheduleText, localMoment, jobRow, agentJobIds, jobsSummary, parseCron, zonedMs, nextCronRun, parseSchedule, jobsSection };
