const { buildPushMessage } = require("./capability-snapshot.cjs");

const LINK_TASK_RESULT_PUSH_METHOD = "task.result.push";
const LINK_TASK_RESULT_UNACKED_METHOD = "task.result.unacked";
const LINK_TASK_RESULT_ACK_METHOD = "task.result.ack";
const TASK_PUSH_ACK_FRAME = "ocuclaw.push.ack";

const TASK_PUSH_CAPABILITY = "taskResultPushV1";
const TASK_PUSH_VERSION = 1;

const TASK_PUSH_MAX = 20;
const TASK_PUSH_STATUSES = new Set(["ok", "failed"]);

const HEADLINE_MAX = 200;
const BODY_MAX = 32 * 1024;
const NAME_MAX = 200;
const ID_MAX = 128;

const RESULT_ID = /^[A-Za-z0-9_-]{22}$/;
const ACK_QUEUE_MAX = 256;
const DEFAULT_RETRY_DELAY_MS = 500;
const RESULT_KEYS = ["resultId", "taskId", "jobId", "jobName", "status", "headline", "body", "createdAtMs"];

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (v     , keys          ) =>
  record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const line = (v     , limit        ) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f]/.test(v);
const optionalLine = (v     , limit        ) => v === null || line(v, limit);

function taskPushResult(raw     )      {
  if (!exactKeys(raw, RESULT_KEYS)) return null;
  if (typeof raw.resultId !== "string" || !RESULT_ID.test(raw.resultId)) return null;
  if (!optionalLine(raw.taskId, ID_MAX) || !line(raw.jobId, ID_MAX) || !optionalLine(raw.jobName, NAME_MAX)) return null;
  if (!TASK_PUSH_STATUSES.has(raw.status) || !line(raw.headline, HEADLINE_MAX)) return null;
  if (typeof raw.body !== "string" || raw.body.length > BODY_MAX) return null;
  if (!Number.isSafeInteger(raw.createdAtMs) || raw.createdAtMs < 0) return null;
  return {
    v: TASK_PUSH_VERSION,
    resultId: raw.resultId,
    taskId: raw.taskId,
    jobId: raw.jobId,
    jobName: raw.jobName,
    status: raw.status,
    headline: raw.headline,
    body: raw.body,
    createdAtMs: raw.createdAtMs,
  };
}

function taskPushAck(raw     )      {
  if (!exactKeys(raw, ["type", "resultId"]) || raw.type !== TASK_PUSH_ACK_FRAME) return null;
  if (typeof raw.resultId !== "string" || !RESULT_ID.test(raw.resultId)) return null;
  return { resultId: raw.resultId };
}

function buildTaskPushMessage(task     , nowMs         )      {
  return {
    ...buildPushMessage({ preview: task.headline, pushOrigin: "cron", urgency: "normal", nowMs }),
    task,
  };
}

function formatTaskPushMessage(task     , nowMs         )         {
  return JSON.stringify(buildTaskPushMessage(task, nowMs));
}

function supportsTaskPush(entry     )          {
  return !!(entry && entry.clientKind === "app" && Array.isArray(entry.clientCapabilities) &&
    entry.clientCapabilities.includes(TASK_PUSH_CAPABILITY));
}

function createHermesTaskPush({
  relay,
  link,
  logger,

  onResultCard = null,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  isQuiet = null,

  taskFor = null,

  popupUntilFor = null,

  onResult = null,

  isRepeat = null,

  isHeld = null,
}     ) {

  const owned = (task     ) => {
    if (task.taskId !== null || typeof taskFor !== "function") return task;
    try {
      const taskId = taskFor(task);
      return line(taskId, ID_MAX) ? { ...task, taskId } : task;
    } catch (_) {
      return task;
    }
  };

  const quiet = (task     ) => {
    if (typeof isQuiet !== "function" || typeof task.taskId !== "string") return false;
    try {
      return isQuiet(task.taskId) === true;
    } catch (_) {
      return false;
    }
  };
  const repeat = (task     ) => {
    if (typeof isRepeat !== "function" || task.status !== "ok") return false;
    try {
      return isRepeat(task) === true;
    } catch (_) {
      return false;
    }
  };
  const heldAnswer = (task     ) => {
    if (typeof isHeld !== "function" || task.status !== "ok") return false;
    try {
      return isHeld(task) === true;
    } catch (_) {
      return false;
    }
  };
  let disposed = false;
  let inFlight = false;
  let retryTimer      = null;

  const queue = new Map             ();

  function warn(message     ) {
    if (logger && typeof logger.warn === "function") logger.warn(`[hermes-task-push] ${message}`);
  }

  function send(task     , clientId      )         {
    if (!relay || typeof relay.sendTaskPushMessage !== "function") return 0;
    return Number(relay.sendTaskPushMessage(task, clientId)) || 0;
  }

  function keepCard(task     , card     )      {
    if (typeof onResultCard !== "function" || task.status !== "ok" || !record(card)) return task;
    try {
      const templateId = onResultCard({
        id: task.resultId,
        jobId: task.jobId,
        jobName: task.jobName,
        status: task.status,
        card,
        createdAtMs: task.createdAtMs,
      });
      return typeof templateId === "string" && templateId ? { ...task, lookTemplateId: templateId } : task;
    } catch (err     ) {
      warn(`card values not kept: ${err && err.message ? err.message : err}`);
      return task;
    }
  }

  function sendAll(list       , clientId      , cards      = null) {
    let sent = 0;
    let refused = 0;
    let held = 0;
    for (const raw of list) {
      const valid = taskPushResult(raw);
      const curated = valid ? owned(valid) : null;
      if (!curated) {
        refused += 1;
        continue;
      }
      if (typeof onResult === "function") {
        try { onResult(curated); } catch (_) {  }
      }

      if (heldAnswer(curated)) {
        held += 1;
        ack({ resultId: curated.resultId });
        continue;
      }

      let task = cards && Object.hasOwn(cards, curated.resultId) ? keepCard(curated, cards[curated.resultId]) : curated;
      if (quiet(task)) {
        held += 1;
        continue;
      }
      if (repeat(task)) {
        held += 1;
        ack({ resultId: task.resultId });
        continue;
      }
      if (typeof popupUntilFor === "function") {
        let until;
        try { until = popupUntilFor(task); } catch (_) {
          refused += 1;
          continue;
        }
        if (until !== null) {
          if (!Number.isSafeInteger(until) || until < task.createdAtMs) {
            refused += 1;
            continue;
          }
          task = { ...task, popupUntilMs: until };
        }
      }
      sent += send(task, clientId);
    }
    if (refused) warn(`refused ${refused} result(s) that failed validation`);
    return held ? { sent, refused, quiet: held } : { sent, refused };
  }

  function scheduleRetry() {
    if (disposed || retryTimer !== null) return;
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      drain();
    }, retryDelayMs);
    if (retryTimer && typeof retryTimer.unref === "function") retryTimer.unref();
  }

  function drain() {
    if (disposed || inFlight || retryTimer !== null || queue.size === 0) return;
    const [resultId, params]      = queue.entries().next().value;
    inFlight = true;
    let pending     ;
    try {
      pending = link.request(LINK_TASK_RESULT_ACK_METHOD, params);
    } catch (err     ) {
      inFlight = false;
      warn(`ack failed: ${err && err.message ? err.message : err}`);
      scheduleRetry();
      return;
    }
    Promise.resolve(pending).then(
      (result     ) => {
        if (disposed) return;
        inFlight = false;
        if (result && result.ok === false && result.error === "invalid_params") {

          if (queue.get(resultId) === params) queue.delete(resultId);
          warn("ack refused: invalid_params");
          drain();
          return;
        }
        if (!result || result.ok !== true) {
          warn(`ack refused: ${result?.error || "unknown"}`);
          scheduleRetry();
          return;
        }
        if (queue.get(resultId) === params) queue.delete(resultId);
        drain();
      },
      (err     ) => {
        if (disposed) return;
        inFlight = false;
        warn(`ack failed: ${err && err.message ? err.message : err}`);
        scheduleRetry();
      },
    );
  }

  function ack(raw     )          {
    if (disposed || !record(raw) || typeof raw.resultId !== "string" || !RESULT_ID.test(raw.resultId)) return false;
    if (!queue.has(raw.resultId)) {
      if (queue.size >= ACK_QUEUE_MAX) {

        warn("ack queue full");
        return false;
      }
      queue.set(raw.resultId, { resultId: raw.resultId });
    }
    drain();
    return true;
  }

  function clientReady(clientId     )                  {
    if (disposed || !link || typeof link.request !== "function") return Promise.resolve(0);
    let pending     ;
    try {
      pending = link.request(LINK_TASK_RESULT_UNACKED_METHOD, {});
    } catch (err     ) {
      warn(`unacked read failed: ${err && err.message ? err.message : err}`);
      return Promise.resolve(0);
    }
    return Promise.resolve(pending).then(
      (reply     ) => {
        if (disposed) return 0;
        const list = record(reply) && reply.ok === true && Array.isArray(reply.results) ? reply.results : null;
        if (!list) {
          warn(`unacked read refused: ${(record(reply) && reply.error) || "unknown"}`);
          return 0;
        }
        return sendAll(list.slice(0, TASK_PUSH_MAX), clientId).sent;
      },
      (err     ) => {
        warn(`unacked read failed: ${err && err.message ? err.message : err}`);
        return 0;
      },
    );
  }

  const methods      = {};
  methods[LINK_TASK_RESULT_PUSH_METHOD] = (params     ) => {
    const list = record(params) && Array.isArray(params.results) ? params.results : null;
    if (!list || list.length > TASK_PUSH_MAX) return { ok: false, error: "invalid_params" };

    return { ok: true, ...sendAll(list, undefined, record(params.cards) ? params.cards : null) };
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (retryTimer !== null) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
    queue.clear();
  }

  return { methods, ack, clientReady, dispose, pendingAcks: () => queue.size };
}

module.exports = { LINK_TASK_RESULT_PUSH_METHOD, LINK_TASK_RESULT_UNACKED_METHOD, LINK_TASK_RESULT_ACK_METHOD, TASK_PUSH_ACK_FRAME, TASK_PUSH_CAPABILITY, TASK_PUSH_VERSION, TASK_PUSH_MAX, TASK_PUSH_STATUSES, taskPushResult, taskPushAck, buildTaskPushMessage, formatTaskPushMessage, supportsTaskPush, createHermesTaskPush };
