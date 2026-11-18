const nodeFs = require("node:fs");
const path = require("node:path");

const { atomicWriteLiveuiLibraryRecord, isValidLiveuiLibraryItemId, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { createTaskOpenUpdateStore, taskOpenUpdateDayKey } = require("./glasses-ui-task-open-update.cjs");
const { curateRunUsage } = require("../domain/task-run-facts.cjs");

const TASK_RUNS_WEEK_DIR = "task-runs-week-v1";
const TASK_RUNS_WEEK_WATCH_FILE = "task-runs-week-watch-v1.json";

const TASK_RUN_WHYS = Object.freeze(["schedule", "open", "refresh", "agent"]);
const TASK_RUNS_WEEK_DAYS = 7;

const TASK_RUN_MATCH_MS = 2 * 60_000;

const TASK_RUN_MARKS_KEPT = 64;

const TASK_RUN_EXPECT_MS = 15 * 60_000;

const TASK_RUNS_WATCH_BEAT_MS = 5 * 60_000;

const TASK_RUNS_WATCH_GAP_MS = 15 * 60_000;
const GAPS_KEPT = 32;
const DAY_MS = 24 * 60 * 60_000;

const KEEP_MS = (TASK_RUNS_WEEK_DAYS + 1) * DAY_MS;
const COUNTED_WHYS = ["schedule", "refresh", "agent"];

function isPlainObject(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stamp(value     )                {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function count(value     ) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

const USAGE_COUNTS = ["runs", "tokens", "priced", "estimated", "included", "chatgpt"];

const TASK_RUN_USAGE_EACH = 24;

function emptyUsage() {
  return { runs: 0, tokens: 0, usd: 0, priced: 0, estimated: 0, included: 0, chatgpt: 0 };
}

function dollars(value        ) {

  return Math.max(0, Math.round(value * 1e6) / 1e6);
}

function validUsage(raw     ) {
  if (!isPlainObject(raw)) return null;
  const out      = emptyUsage();
  for (const key of USAGE_COUNTS) out[key] = count(raw[key]);
  out.usd = typeof raw.usd === "number" && Number.isFinite(raw.usd) && raw.usd > 0 ? dollars(raw.usd) : 0;
  return out.runs > 0 ? out : null;
}

function addUsage(bucket     , usage     , sign = 1) {
  bucket.runs = Math.max(0, bucket.runs + sign);
  bucket.tokens = Math.max(0, bucket.tokens + sign * usage.tokens);
  if (usage.cost === "actual" || usage.cost === "estimated") {
    bucket.priced = Math.max(0, bucket.priced + sign);
    bucket.usd = dollars(bucket.usd + sign * (usage.usd || 0));
    if (usage.cost === "estimated") bucket.estimated = Math.max(0, bucket.estimated + sign);
  } else if (usage.cost === "included") {
    bucket.included = Math.max(0, bucket.included + sign);
    if (usage.plan === "chatgpt") bucket.chatgpt = Math.max(0, bucket.chatgpt + sign);
  }
}

function sameUsage(a     , b     ) {
  return !!a && !!b && a.tokens === b.tokens && a.cost === b.cost && a.usd === b.usd && a.plan === b.plan;
}

function taskRunsWeekDays(nowMs        )           {
  const today = new Date(nowMs);
  const days           = [];
  for (let back = TASK_RUNS_WEEK_DAYS - 1; back >= 0; back -= 1) {

    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12);
    days.push(taskOpenUpdateDayKey(day.getTime()));
  }
  return days;
}

function taskRunsWeekStartMs(nowMs        ) {
  const today = new Date(nowMs);
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() - (TASK_RUNS_WEEK_DAYS - 1)).getTime();
}

function defaultRecord(taskId        ) {
  return {
    schemaVersion: 1,
    taskId,

    days: {}                       ,

    marks: []         ,

    now: null       ,
  };
}

function validRecord(raw     , taskId        ) {
  const record = defaultRecord(taskId);
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || raw.taskId !== taskId) return record;
  if (isPlainObject(raw.days)) {
    for (const [day, entry] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isPlainObject(entry)) continue;
      const kept      = {};
      for (const why of COUNTED_WHYS) if (count((entry       )[why])) kept[why] = (entry       )[why];
      if (isPlainObject((entry       ).usage)) {
        const usage      = {};
        for (const why of TASK_RUN_WHYS) {
          const bucket = validUsage((entry       ).usage[why]);
          if (bucket) usage[why] = bucket;
        }
        if (Object.keys(usage).length) kept.usage = usage;
      }
      if (Object.keys(kept).length) record.days[day] = kept;
    }
  }
  if (Array.isArray(raw.marks)) {
    record.marks = raw.marks.filter((mark     ) => isPlainObject(mark) && stamp(mark.atMs) !== null &&
        TASK_RUN_WHYS.includes(mark.why) && (mark.src === "job" || mark.src === "relay"))
      .map((mark     ) => {
        const usage = curateRunUsage(mark.u);
        return { atMs: mark.atMs, why: mark.why, src: mark.src,
          ...(typeof mark.id === "string" && mark.id.length <= 128 ? { id: mark.id } : {}),
          ...(usage ? { u: usage } : {}) };
      })
      .slice(-TASK_RUN_MARKS_KEPT);
  }
  if (isPlainObject(raw.now) && stamp(raw.now.atMs) !== null) record.now = { atMs: raw.now.atMs };
  return record;
}

function validWatch(raw     ) {
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || stamp(raw.sinceMs) === null) return null;
  return {
    schemaVersion: 1,
    sinceMs: raw.sinceMs,
    aliveMs: stamp(raw.aliveMs) ?? raw.sinceMs,
    gaps: Array.isArray(raw.gaps)
      ? raw.gaps.filter((gap     ) => isPlainObject(gap) && stamp(gap.fromMs) !== null && stamp(gap.toMs) !== null &&
          gap.toMs >= gap.fromMs).map((gap     ) => ({ fromMs: gap.fromMs, toMs: gap.toMs })).slice(-GAPS_KEPT)
      : [],
  };
}

function createTaskRunsWeekStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const dir = path.join(libraryDir, TASK_RUNS_WEEK_DIR);
  const watchFile = path.join(libraryDir, TASK_RUNS_WEEK_WATCH_FILE);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const opens = opts.openStore || createTaskOpenUpdateStore({ fs, libraryDir, now });
  const fileFor = (taskId        ) => path.join(dir, `${taskId}.json`);

  function read(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return null;
    let raw      = null;
    try {
      raw = JSON.parse(fs.readFileSync(fileFor(taskId), "utf8"));
    } catch (_) {
      raw = null;
    }
    return validRecord(raw, taskId);
  }

  function write(record     ) {
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: fileFor(record.taskId), record }).status === "written";
  }

  function readWatch() {
    try {
      return validWatch(JSON.parse(fs.readFileSync(watchFile, "utf8")));
    } catch (_) {
      return null;
    }
  }

  function writeWatch(watch     ) {
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: watchFile, record: watch }).status === "written";
  }

  function prune(record     , nowMs        ) {
    const keep = new Set(taskRunsWeekDays(nowMs));

    keep.add(taskOpenUpdateDayKey(taskRunsWeekStartMs(nowMs) - DAY_MS / 2));
    for (const day of Object.keys(record.days)) if (!keep.has(day)) delete record.days[day];
    record.marks = record.marks.filter((mark     ) => nowMs - mark.atMs < KEEP_MS).slice(-TASK_RUN_MARKS_KEPT);
    if (record.now && nowMs - record.now.atMs >= TASK_RUN_EXPECT_MS) record.now = null;
  }

  function bump(record     , why        , atMs        ) {
    if (!COUNTED_WHYS.includes(why)) return;
    const day = taskOpenUpdateDayKey(atMs);
    const entry = record.days[day] || (record.days[day] = {});
    entry[why] = count(entry[why]) + 1;
  }

  function noteUsage(record     , entry     , usage     ) {
    if (!usage || sameUsage(entry.u, usage)) return false;
    const day = taskOpenUpdateDayKey(entry.atMs);
    const days = record.days[day] || (record.days[day] = {});
    const byWhy = days.usage || (days.usage = {});
    const bucket = byWhy[entry.why] || (byWhy[entry.why] = emptyUsage());
    if (entry.u) addUsage(bucket, entry.u, -1);
    addUsage(bucket, usage);
    entry.u = usage;
    return true;
  }

  function mark(record     , entry     ) {
    record.marks = [...record.marks, entry].sort((a     , b     ) => a.atMs - b.atMs).slice(-TASK_RUN_MARKS_KEPT);
  }

  function openJobRun(taskId        , atMs        , nowMs        ) {
    let pending      = null;
    try {
      pending = opens.pending(taskId, nowMs);
    } catch (_) {
      pending = null;
    }
    return pending && pending.via === "job" && atMs >= pending.atMs - 1000 ? pending : null;
  }

  function noteJobRun(taskId     , { atMs, id = null, usage = null }      = {}) {
    const at = stamp(atMs);
    const nowMs = now();
    if (at === null || !isValidLiveuiLibraryItemId(taskId) || nowMs - at >= KEEP_MS || at > nowMs + TASK_RUN_MATCH_MS) return null;
    const record = read(taskId);
    if (!record) return null;
    prune(record, nowMs);
    const resultId = typeof id === "string" && id ? id : null;
    const took = curateRunUsage(usage);
    const jobMarks = record.marks.filter((entry     ) => entry.src === "job");
    if (resultId && jobMarks.some((entry     ) => entry.id === resultId)) return null;

    const near = jobMarks.filter((entry     ) => Math.abs(entry.atMs - at) <= TASK_RUN_MATCH_MS &&
      (!resultId || !entry.id)).sort((a     , b     ) => Math.abs(a.atMs - at) - Math.abs(b.atMs - at));
    const same = near[0];
    if (same) {

      let changed = false;
      if (resultId && !same.id) {
        same.id = resultId;
        changed = true;
      }
      if (noteUsage(record, same, took)) changed = true;
      if (changed) write(record);
      return null;
    }

    if (record.marks.length >= TASK_RUN_MARKS_KEPT && at <= record.marks[0].atMs) return null;
    let why = "schedule";
    if (openJobRun(taskId, at, nowMs)) why = "open";
    else if (record.now && at >= record.now.atMs - 1000) {
      why = "refresh";
      record.now = null;
    }
    bump(record, why, at);
    const entry      = { atMs: at, why, src: "job", ...(resultId ? { id: resultId } : {}) };
    noteUsage(record, entry, took);
    mark(record, entry);
    return write(record) ? why : null;
  }

  function noteRelayRun(taskId     , { atMs, why }      = {}) {
    const at = stamp(atMs) ?? now();
    if (!isValidLiveuiLibraryItemId(taskId) || !["refresh", "agent"].includes(why)) return null;
    const record = read(taskId);
    if (!record) return null;
    prune(record, now());
    bump(record, why, at);
    mark(record, { atMs: at, why, src: "relay" });
    return write(record) ? why : null;
  }

  function expectRunNow(taskId     , atMs         = now()) {
    if (!isValidLiveuiLibraryItemId(taskId)) return false;
    const record = read(taskId);
    if (!record) return false;
    prune(record, now());
    record.now = { atMs };
    return write(record);
  }

  function forgetRunNow(taskId     , atMs        ) {
    const record = read(taskId);
    if (!record || !record.now || record.now.atMs !== atMs) return false;
    record.now = null;
    return write(record);
  }

  function openRunsOf(taskId        )           {
    try {
      const record      = opens.read(taskId);
      return record && Array.isArray(record.openRuns) ? record.openRuns : [];
    } catch (_) {
      return [];
    }
  }

  function about(nowMs        ) {
    const watch = readWatch();
    if (!watch) return true;
    const from = taskRunsWeekStartMs(nowMs);
    if (watch.sinceMs > from) return true;
    if (watch.gaps.some((gap     ) => gap.toMs > from && gap.fromMs < nowMs)) return true;

    return nowMs - watch.aliveMs > TASK_RUNS_WATCH_GAP_MS;
  }

  function week(taskId     , options      = {}) {
    const nowMs = stamp(options.nowMs) ?? now();
    const record = read(taskId);
    if (!record) return null;
    const keys = taskRunsWeekDays(nowMs);
    const days = keys.map((day) => {
      const entry = record.days[day] || {};
      return { day, schedule: count(entry.schedule), open: 0, refresh: count(entry.refresh), agent: count(entry.agent) };
    });
    const from = taskRunsWeekStartMs(nowMs);
    for (const ms of openRunsOf(record.taskId)) {
      if (ms < from || ms > nowMs) continue;
      const day = days.find((entry) => entry.day === taskOpenUpdateDayKey(ms));
      if (day) day.open += 1;
    }
    const why      = { schedule: 0, open: 0, refresh: 0, agent: 0 };
    for (const day of days) for (const key of TASK_RUN_WHYS) why[key] += (day       )[key];
    const total = TASK_RUN_WHYS.reduce((sum, key) => sum + why[key], 0);
    const usage = weekUsage(record, keys, from);
    return { total, about: options.scheduled === false ? false : about(nowMs), why, days, ...(usage ? { usage } : {}) };
  }

  function weekUsage(record     , keys          , fromMs        ) {
    const all      = emptyUsage();
    const byWhy      = {};
    for (const key of TASK_RUN_WHYS) byWhy[key] = emptyUsage();
    for (const day of keys) {
      const usage = record.days[day]?.usage;
      if (!isPlainObject(usage)) continue;
      for (const key of TASK_RUN_WHYS) {
        const bucket = validUsage(usage[key]);
        if (!bucket) continue;
        for (const target of [all, byWhy[key]]) {
          for (const field of USAGE_COUNTS) target[field] += bucket[field];
          target.usd = dollars(target.usd + bucket.usd);
        }
      }
    }
    if (all.runs <= 0) return null;
    const each = record.marks.filter((entry     ) => entry.u && entry.atMs >= fromMs)
      .sort((a     , b     ) => b.atMs - a.atMs).slice(0, TASK_RUN_USAGE_EACH)
      .map((entry     ) => ({ atMs: entry.atMs, why: entry.why, tokens: entry.u.tokens, cost: entry.u.cost, usd: entry.u.usd,
        ...(entry.u.plan ? { plan: entry.u.plan } : {}) }));
    return { ...all, why: byWhy, each };
  }

  function start(nowMs         = now()) {
    const watch = readWatch();
    if (!watch) return writeWatch({ schemaVersion: 1, sinceMs: nowMs, aliveMs: nowMs, gaps: [] });
    if (nowMs - watch.aliveMs > TASK_RUNS_WATCH_GAP_MS) watch.gaps.push({ fromMs: watch.aliveMs, toMs: nowMs });
    watch.gaps = watch.gaps.filter((gap     ) => nowMs - gap.toMs < KEEP_MS).slice(-GAPS_KEPT);
    watch.aliveMs = Math.max(watch.aliveMs, nowMs);
    return writeWatch(watch);
  }

  function beat(nowMs         = now()) {
    const watch = readWatch();
    if (!watch) return start(nowMs);
    if (nowMs - watch.aliveMs > TASK_RUNS_WATCH_GAP_MS) return start(nowMs);
    watch.aliveMs = Math.max(watch.aliveMs, nowMs);
    return writeWatch(watch);
  }

  function clear(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return false;
    try {
      fs.unlinkSync(fileFor(taskId));
      return true;
    } catch (_) {
      return false;
    }
  }

  return { dir, read, noteJobRun, noteRelayRun, expectRunNow, forgetRunNow, openRunsOf, week, start, beat, clear, readWatch };
}

function createTaskRunsWeek(opts      = {}) {
  const store = opts.store;
  const logger = opts.logger || null;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const taskFor = typeof opts.taskFor === "function" ? opts.taskFor : () => null;

  const agentAsked = new Map                ();

  function counted(taskId        , why               , from        ) {
    if (why) logger?.info?.(`[task-runs-week] counted task=${taskId} why=${why} from=${from}`);
  }

  return {
    store,

    onResult(result     ) {
      if (!isPlainObject(result)) return null;
      let taskId = typeof result.taskId === "string" && result.taskId ? result.taskId : null;
      if (!taskId) {
        try { taskId = taskFor(result); } catch (_) { taskId = null; }
      }
      if (typeof taskId !== "string" || !taskId) return null;
      const why = store.noteJobRun(taskId, { atMs: result.createdAtMs, id: result.resultId || result.id || null });
      counted(taskId, why, "result");
      return why;
    },

    onJobRuns(list     ) {
      if (!Array.isArray(list)) return;
      for (const entry of list) {
        const run = isPlainObject(entry) ? entry.lastRun : null;
        if (!isPlainObject(run) || !["ok", "quiet", "failed"].includes(run.outcome)) continue;
        const atMs = stamp(run.endedAtMs) ?? stamp(run.startedAtMs);
        if (atMs === null || typeof entry.taskId !== "string") continue;
        try {

          counted(entry.taskId, store.noteJobRun(entry.taskId, { atMs, usage: run.usage ?? null }), "run_facts");
        } catch (_) {  }
      }
    },

    agentRefreshAsked(taskId     ) {
      if (typeof taskId === "string" && taskId) agentAsked.set(taskId, now());
    },

    runNowAsked(taskId     ) {
      return store.expectRunNow(taskId);
    },

    onRelayRunEnded(run     ) {
      if (!isPlainObject(run) || typeof run.taskId !== "string" || run.endedReason === "launch_failed") return null;
      const startedAt = stamp(run.startedAt);

      if (run.feed && startedAt !== null && store.openRunsOf(run.taskId)
        .some((ms     ) => Number.isFinite(ms) && startedAt >= ms && startedAt - ms <= 10_000)) return null;
      const asked = agentAsked.get(run.taskId);
      const byAgent = !!run.feed && asked !== undefined && startedAt !== null && startedAt >= asked - 1000 &&
        startedAt - asked <= TASK_RUN_EXPECT_MS;
      if (byAgent) agentAsked.delete(run.taskId);
      const why = store.noteRelayRun(run.taskId, { atMs: stamp(run.endedAt) ?? now(), why: byAgent ? "agent" : "refresh" });
      counted(run.taskId, why, "relay_run");
      return why;
    },
    week(taskId        , options      = {}) {
      return store.week(taskId, options);
    },
    clear(taskId        ) {
      agentAsked.delete(taskId);
      return store.clear(taskId);
    },
  };
}

module.exports = { TASK_RUNS_WEEK_DIR, TASK_RUNS_WEEK_WATCH_FILE, TASK_RUN_WHYS, TASK_RUNS_WEEK_DAYS, TASK_RUN_MATCH_MS, TASK_RUN_MARKS_KEPT, TASK_RUN_EXPECT_MS, TASK_RUNS_WATCH_BEAT_MS, TASK_RUNS_WATCH_GAP_MS, TASK_RUN_USAGE_EACH, taskRunsWeekDays, taskRunsWeekStartMs, createTaskRunsWeekStore, createTaskRunsWeek };
