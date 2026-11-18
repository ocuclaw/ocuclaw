const LINK_TASK_RUN_ANSWER_METHOD = "task.run.answer";
const TASK_ALERT_FENCE = "ocuclaw-alert";

const ALERT_SAW_MAX = 200;

const ALERT_JOBS_MAX = 128;
const RESULT_ID = /^[A-Za-z0-9_-]{22}$/;
const STORE_VERSION = 1;
const TASK_ALERT_MEMORY_FILE = "task-alert-memory.json";

const TASK_ALERT_STATE_PROMPT =
  "OcuClaw alert rule: end every answer, a silent one too, with one fenced ocuclaw-alert block " +
  'holding one JSON object: {"notify": true or false, "saw": "..."}. notify is true only when ' +
  "this alert should go off now. saw lists the values you read that decide it, short, in the " +
  'same plain form every run, such as "unread 3" or "price 412.50": no times, dates or words ' +
  "that change between runs. If you show nothing, keep your silent reply alone on the first " +
  "line and put the block after it.";

const ALERT_BLOCK = /^[ \t]*```ocuclaw-alert[ \t]*\n([\s\S]*?)\n?^[ \t]*```[ \t]*$\n?/gm;
const ALERT_OPEN_TAIL = /^[ \t]*```ocuclaw-alert[ \t]*(?:\n[\s\S]*)?$(?![\s\S])/m;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const finiteMs = (v     ) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

function alertSawKey(saw     )                {
  if (typeof saw !== "string") return null;
  const key = saw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!。]+$/u, "").trim();
  return key ? Array.from(key).slice(0, ALERT_SAW_MAX).join("") : null;
}

function parseState(raw        )      {
  try {
    const value = JSON.parse(raw);
    if (!record(value) || typeof value.notify !== "boolean") return null;
    return { notify: value.notify, saw: alertSawKey(value.saw) };
  } catch (_) {
    return null;
  }
}

function splitAlertState(text     )                               {
  if (typeof text !== "string" || !text.includes("```" + TASK_ALERT_FENCE)) {
    return { text: typeof text === "string" ? text : "", state: null };
  }
  let state = null;
  for (const block of text.matchAll(ALERT_BLOCK)) state = parseState(block[1]) ?? state;
  const rest = text.replace(ALERT_BLOCK, "").replace(ALERT_OPEN_TAIL, "");
  return { text: rest.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, ""), state };
}

function alertResultKey(headline     , body     )                {
  const words = `${typeof headline === "string" ? headline : ""}\n${typeof body === "string" ? body : ""}`
    .normalize("NFKC").replace(/\s+/g, " ").trim();
  return words || null;
}

function blankJob() {
  return { saw: null                 , quietAtMs: null                 , shown: null       , atMs: 0 };
}

function curateJob(raw     )      {
  if (!record(raw)) return null;
  const shown = record(raw.shown) && typeof raw.shown.resultId === "string" && RESULT_ID.test(raw.shown.resultId) &&
    typeof raw.shown.key === "string" && finiteMs(raw.shown.createdAtMs) !== null
    ? { resultId: raw.shown.resultId, key: raw.shown.key, createdAtMs: raw.shown.createdAtMs }
    : null;
  return {
    saw: alertSawKey(raw.saw),
    quietAtMs: finiteMs(raw.quietAtMs),
    shown,
    atMs: finiteMs(raw.atMs) ?? 0,
  };
}

function alertRunVerdict(run     , memory     , atMs        )                                   {
  const was = curateJob(memory) || blankJob();
  const state = record(run) && record(run.state) ? run.state : null;
  const silent = !!(record(run) && run.silent === true);
  if (silent || (state && state.notify === false)) {

    const saw = state && state.notify === false ? state.saw : null;
    return { verdict: "quiet", memory: { ...was, saw, quietAtMs: atMs, atMs } };
  }
  if (state && state.saw !== null && state.saw === was.saw) {
    return { verdict: "same", memory: { ...was, atMs } };
  }
  return { verdict: "alert", memory: { ...was, saw: state ? state.saw : null, atMs } };
}

function alertResultRepeat(result     , memory     )                                   {
  const was = curateJob(memory) || blankJob();
  if (!record(result) || result.status !== "ok" || typeof result.resultId !== "string" ||
    !RESULT_ID.test(result.resultId) || finiteMs(result.createdAtMs) === null) {
    return { repeat: false, memory: was };
  }
  const key = alertResultKey(result.headline, result.body);
  const shown = was.shown;
  if (key !== null && shown && shown.resultId !== result.resultId && shown.key === key &&
    result.createdAtMs > shown.createdAtMs && !(was.quietAtMs !== null && was.quietAtMs > shown.createdAtMs)) {
    return { repeat: true, memory: was };
  }
  if (key !== null && (!shown || result.createdAtMs >= shown.createdAtMs)) {
    return { repeat: false, memory: { ...was, shown: { resultId: result.resultId, key, createdAtMs: result.createdAtMs } } };
  }
  return { repeat: false, memory: was };
}

function createTaskAlertMemory({ stateDir = null, fs = null, path = null, now = Date.now, logger = null }      = {}) {
  const file = typeof stateDir === "string" && stateDir && fs && path ? path.join(stateDir, TASK_ALERT_MEMORY_FILE) : null;
  let jobs      = {};
  if (file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (record(parsed) && parsed.version === STORE_VERSION && record(parsed.jobs)) {
        for (const [jobId, raw] of Object.entries(parsed.jobs)) {
          const job = curateJob(raw);
          if (job) jobs[jobId] = job;
        }
      }
    } catch (_) {

    }
  }

  function save() {
    const ids = Object.keys(jobs);
    if (ids.length > ALERT_JOBS_MAX) {
      for (const jobId of ids.sort((a, b) => jobs[a].atMs - jobs[b].atMs).slice(0, ids.length - ALERT_JOBS_MAX)) {
        delete jobs[jobId];
      }
    }
    if (!file) return;
    try {
      const tmp = `${file}.tmp.${Math.random().toString(36).slice(2, 10)}`;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, jobs }) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err     ) {
      if (logger && typeof logger.warn === "function") {
        logger.warn(`[task-alert] memory not kept: ${err && err.code ? err.code : "write failed"}`);
      }
    }
  }

  return {

    runEnd(jobId        , run     )         {
      const { verdict, memory } = alertRunVerdict(run, jobs[jobId], Math.trunc(now()));
      jobs[jobId] = memory;
      save();
      return verdict;
    },

    isRepeat(result     )          {
      if (!record(result) || typeof result.jobId !== "string" || !result.jobId) return false;
      const { repeat, memory } = alertResultRepeat(result, jobs[result.jobId]);
      if (!repeat && memory !== jobs[result.jobId]) {
        jobs[result.jobId] = { ...memory, atMs: Math.max(memory.atMs, Math.trunc(now())) };
        save();
      }
      return repeat;
    },
    get(jobId        ) {
      return jobs[jobId] ? { ...jobs[jobId] } : null;
    },
  };
}

module.exports = { LINK_TASK_RUN_ANSWER_METHOD, TASK_ALERT_FENCE, ALERT_SAW_MAX, TASK_ALERT_MEMORY_FILE, TASK_ALERT_STATE_PROMPT, alertSawKey, splitAlertState, alertResultKey, alertRunVerdict, alertResultRepeat, createTaskAlertMemory };
