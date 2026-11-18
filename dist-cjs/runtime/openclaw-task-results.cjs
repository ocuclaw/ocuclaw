const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { OPENCLAW_SILENT_TOKEN } = require("./openclaw-task-prompt.cjs");
const { taskIdOfJob, testIdOfJob } = require("./openclaw-task-schedule.cjs");
const { cronJobOfSessionKey } = require("./openclaw-automation-run-guard.cjs");
const { classifyTaskFailure, curateLastRun, curateRunUsage, redactHostText, soleToolSignIn, taskRunHeld } = require("../domain/task-run-facts.cjs");
const { splitAlertState } = require("../domain/task-alert-state.cjs");
const { agentDeclaredFailure, hostRefusedRun } = require("../domain/task-run-prompt.cjs");
const { OPENCLAW_RUN_COST_RETRY_MS, OPENCLAW_RUN_COST_SETTLE_MS, OPENCLAW_RUN_COST_TRIES, cronRunKey, openClawRunUsage, openClawSessionCost, openClawSignInKind } = require("./openclaw-task-run-usage.cjs");
const { validTaskToolFailures } = require("../tools/glasses-ui-task-tool-failures.cjs");

const OPENCLAW_TASK_RESULTS_FILE = "openclaw-task-results.json";
const STORE_VERSION = 1;

const RECENT_LIMIT = 30;
const LATEST_JOBS_LIMIT = 200;
const CARD_MAX_BYTES = 16 * 1024;
const HEADLINE_MAX = 200;
const BODY_MAX = 32 * 1024;
const ERROR_MAX = 500;

const TASK_OUTPUT_JOBS_MAX = 8;
const TASK_OUTPUT_BODY_CHARS = 4096;
const DEFAULT_HEADLINE = "Scheduled task";
const UNDONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UNDONE_MAX = 50;

const LATEST_MAX = 50;
const PUSH_MAX = 20;
const PAGE_ERROR_MAX = 300;
const ID_MAX = 128;
const NAME_MAX = 200;
const AGAIN_DELAY_MS = 30 * 60 * 1000;
const RESULT_ID = /^[A-Za-z0-9_-]{22}$/;
const CONTROL = /[\u0000-\u001f\u007f]+/g;

const SUMMARY_CUT = 2000;
const KEPT_MAX = 64;
const KEPT_TTL_MS = 2 * 60 * 60 * 1000;
const SEEN_PER_JOB = 50;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const RUNS_PAGE = 50;
const SINGLETON = Symbol.for("ocuclaw.openclawTaskResults");

const BUSY_RETRY_WITHIN_MS = 6 * 60 * 1000;

const RUNNING_STALE_MS = 6 * 60 * 60 * 1000;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v     ) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const CARD_BLOCK = /^[ \t]*```ocuclaw-card[ \t]*\n([\s\S]*?)\n?^[ \t]*```[ \t]*$\n?/gm;
const CARD_OPEN_TAIL = /^[ \t]*```ocuclaw-card[ \t]*(?:\n[\s\S]*)?$(?![\s\S])/m;
const HEADING = /^(?:#{1,6}\s+)?(.*?)\s*$/;

const chars = (text        ) => Array.from(text);

function clip(text        , limit        ) {
  const points = chars(text);
  return points.length <= limit ? text : points.slice(0, limit - 1).join("").trimEnd() + "…";
}

function stripEmphasis(line        ) {
  let text = (HEADING.exec(line)       )[1];
  for (const mark of ["**", "__"]) {
    if (text.length > 2 * mark.length && text.startsWith(mark) && text.endsWith(mark)) {
      text = text.slice(mark.length, -mark.length).trim();
    }
  }
  return text;
}

function parseCard(raw     ) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > CARD_MAX_BYTES) return null;
  try {
    const value = JSON.parse(raw);
    return record(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function splitCard(text        )                {

  text = splitAlertState(text).text;
  let card = null;
  const blocks = [...text.matchAll(CARD_BLOCK)];
  if (blocks.length > 0) {
    card = parseCard(blocks[blocks.length - 1][1]);
    text = text.replace(CARD_BLOCK, "");
  }
  return [text.replace(CARD_OPEN_TAIL, ""), card];
}

function isSilentAnswer(text     ) {
  return typeof text !== "string" || !text.trim() || text.trim() === OPENCLAW_SILENT_TOKEN;
}

function parseRunAnswer(text     , jobName      = null) {
  const name = typeof jobName === "string" && jobName.trim() ? jobName.trim() : null;
  const [rest, card] = splitCard(String(text ?? "").replace(/\r\n/g, "\n"));
  const lines = rest.replace(/^\n+|\n+$/g, "").split("\n");
  let headline = "";
  let restAt = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim()) {
      headline = stripEmphasis(lines[index].trim());
      restAt = index + 1;
      break;
    }
  }
  const body = headline ? lines.slice(restAt).join("\n").trim() : "";
  if (!headline) headline = name || DEFAULT_HEADLINE;
  return { headline: clip(headline, HEADLINE_MAX), body: clip(body, BODY_MAX), card };
}

function sentence(text        ) {
  const upper = text.slice(0, 1).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(upper) ? upper : `${upper}.`;
}

function failedRun(error     , jobName      = null) {
  const name = typeof jobName === "string" && jobName.trim() ? jobName.trim() : DEFAULT_HEADLINE;
  const cause = clip(String(error ?? "").replace(/\s+/g, " ").trim().replace(/\.+$/, "").trim(), ERROR_MAX) ||
    "unknown error";
  return { headline: clip(`${name} failed`, HEADLINE_MAX), body: sentence(cause), card: null, error: cause };
}

function displayLine(value     , limit        ) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(CONTROL, " ").trim();
  return text ? clip(text, limit) : null;
}

function pushWire(result     ) {
  return {
    resultId: result.id,
    taskId: displayLine(result.taskId, ID_MAX),
    jobId: displayLine(result.jobId, ID_MAX) || "job",
    jobName: displayLine(result.jobName, NAME_MAX),
    status: result.status,
    headline: displayLine(result.headline, HEADLINE_MAX) || DEFAULT_HEADLINE,
    body: result.body.slice(0, BODY_MAX),
    createdAtMs: result.createdAtMs,
  };
}

function pageError(error     ) {
  return displayLine(error === null || error === undefined ? null : redactHostText(error), PAGE_ERROR_MAX);
}

function latestWire(ok     , failed     , undone           = [], run      = null) {
  const job = ok || failed;
  return {
    jobId: displayLine(job.jobId, ID_MAX) || "job",
    jobName: displayLine(job.jobName, NAME_MAX),
    latest: ok ? pushWire(ok) : null,
    latestAcked: !!(ok && ok.ackedAtMs !== null),
    latestDone: !!(ok && ok.doneAtMs !== null),
    undoneAtMs: undone.slice(-UNDONE_MAX),
    failedAtMs: failed ? failed.createdAtMs : null,

    failedError: failed ? pageError(failed.error) : null,
    ...(run ? { run } : {}),
  };
}

function runOnlyWire(jobId        , jobName     , run     ) {
  return {
    jobId: displayLine(jobId, ID_MAX) || "job",
    jobName: displayLine(jobName, NAME_MAX),
    latest: null,
    latestAcked: false,
    latestDone: false,
    undoneAtMs: [],
    failedAtMs: null,
    failedError: null,
    run,
  };
}

function emptyState() {
  return { version: STORE_VERSION, seq: 0, results: []         , jobs: {}        };
}

function validResult(row     ) {
  return record(row) && RESULT_ID.test(row.id) && typeof row.jobId === "string" && Number.isSafeInteger(row.seq) &&
    (row.status === "ok" || row.status === "failed") && typeof row.headline === "string" &&
    typeof row.body === "string" && Number.isSafeInteger(row.createdAtMs);
}

function createOpenClawTaskResultStore({ stateDir, fs: fsImpl = fs, now = Date.now }      = {}) {
  const file = typeof stateDir === "string" && stateDir ? path.join(stateDir, OPENCLAW_TASK_RESULTS_FILE) : null;
  let state      = emptyState();
  if (file) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(file, "utf8"));
      if (record(parsed) && parsed.version === STORE_VERSION && Array.isArray(parsed.results)) {
        state = {
          version: STORE_VERSION,
          seq: Number.isSafeInteger(parsed.seq) ? parsed.seq : 0,
          results: parsed.results.filter(validResult),
          jobs: record(parsed.jobs) ? parsed.jobs : {},
        };
        for (const row of state.results) state.seq = Math.max(state.seq, row.seq);
      }
    } catch (_) {

    }
  }

  function save() {
    if (!file) return;
    const tmp = `${file}.tmp.${process.pid}`;
    fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fsImpl.writeFileSync(tmp, JSON.stringify(state) + "\n", { mode: 0o600 });
    fsImpl.renameSync(tmp, file);
  }

  function jobState(jobId        ) {
    if (!record(state.jobs[jobId])) state.jobs[jobId] = { cursorMs: null, seen: [] };
    return state.jobs[jobId];
  }

  function trim() {
    const bySeq = [...state.results].sort((a, b) => b.seq - a.seq);
    const keep = new Set(bySeq.slice(0, RECENT_LIMIT).map((row) => row.seq));
    const latest = new Map                ();
    for (const row of bySeq) if (!latest.has(row.jobId)) latest.set(row.jobId, row.seq);
    [...latest.values()].slice(0, LATEST_JOBS_LIMIT).forEach((seq) => keep.add(seq));
    state.results = state.results.filter((row     ) => keep.has(row.seq));
  }

  function insert(fields     ) {
    state.seq += 1;
    const row = {
      id: crypto.randomBytes(16).toString("base64url"),
      seq: state.seq,
      jobId: fields.jobId,
      jobName: fields.jobName ?? null,
      taskId: fields.taskId ?? null,
      status: fields.status,
      headline: fields.headline,
      body: fields.body,
      card: record(fields.card) ? fields.card : null,
      error: fields.error ?? null,
      truncated: fields.truncated === true,
      createdAtMs: fields.createdAtMs,
      ackedAtMs: null,
      doneAtMs: null,
      againAtMs: null,
      runAtMs: fields.runAtMs ?? null,
      runId: fields.runId ?? null,
    };

    const toolFailures = validTaskToolFailures(fields.toolFailures);
    if (toolFailures) (row       ).toolFailures = toolFailures;
    state.results.push(row);
    trim();
    return row;
  }

  const ordered = () => [...state.results].sort((a, b) => a.seq - b.seq);
  const copy = (row     ) => (row ? { ...row } : null);

  return {

    seen(jobId        , runKey        ) {
      const job = state.jobs[jobId];
      return !!(job && Array.isArray(job.seen) && job.seen.includes(runKey));
    },

    setLastRun(jobId        , lastRun     , jobName      = null) {
      const next = curateLastRun(lastRun);
      if (!next) return false;
      const job = jobState(jobId);
      const known = curateLastRun(job.lastRun);
      if (known && known.endedAtMs >= next.endedAtMs) return false;
      job.lastRun = next;
      const name = displayLine(jobName, NAME_MAX);
      if (name) job.jobName = name;
      save();
      return true;
    },

    setLastRunUsage(jobId        , endedAtMs        , usage     ) {
      const job = state.jobs[jobId];
      const known = record(job) ? curateLastRun(job.lastRun) : null;
      const next = curateRunUsage(usage);
      if (!known || known.endedAtMs !== endedAtMs || !next) return false;
      const was = known.usage;
      if (was && was.tokens === next.tokens && was.cost === next.cost && was.usd === next.usd && was.plan === next.plan) return false;
      job.lastRun = { ...known, usage: next };
      save();
      return true;
    },
    lastRun(jobId        ) {
      const job = state.jobs[jobId];
      return record(job) ? curateLastRun(job.lastRun) : null;
    },
    jobName(jobId        ) {
      const job = state.jobs[jobId];
      return record(job) ? displayLine(job.jobName, NAME_MAX) : null;
    },

    markSeen(jobId        , runKey        ) {
      const job = jobState(jobId);
      job.seen = [...(Array.isArray(job.seen) ? job.seen : []), runKey].slice(-SEEN_PER_JOB);
      save();
    },

    record(fields     , runKey                = null) {
      if (runKey !== null) {
        if (this.seen(fields.jobId, runKey)) return null;
        const job = jobState(fields.jobId);
        job.seen = [...(Array.isArray(job.seen) ? job.seen : []), runKey].slice(-SEEN_PER_JOB);
      }
      const row = insert(fields);
      save();
      return copy(row);
    },

    setCursor(jobId        , ms        ) {
      const job = jobState(jobId);
      if (!Number.isSafeInteger(job.cursorMs) || ms > job.cursorMs) {
        job.cursorMs = ms;
        save();
      }
    },
    cursor(jobId        ) {
      const job = state.jobs[jobId];
      return job && Number.isSafeInteger(job.cursorMs) ? job.cursorMs : null;
    },
    get(id        ) {
      return copy(state.results.find((row     ) => row.id === id));
    },
    ack(id        ) {
      const row = state.results.find((r     ) => r.id === id);
      if (!row || row.ackedAtMs !== null) return false;
      row.ackedAtMs = now();
      save();
      return true;
    },
    listUnacked() {
      return ordered().filter((row) => row.ackedAtMs === null).map(copy);
    },

    latestByJob() {
      const pairs = new Map               ();
      for (const row of ordered().reverse()) {
        const pair = pairs.get(row.jobId) || [null, null];
        const side = row.status === "failed" ? 1 : 0;
        if (!pair[side]) pair[side] = copy(row);
        pairs.set(row.jobId, pair);
      }
      return [...pairs.values()];
    },
    recentForJob(jobId        , limit = RECENT_LIMIT) {
      return ordered().reverse().filter((row) => row.jobId === jobId).slice(0, Math.max(0, Math.min(limit, RECENT_LIMIT)))
        .map(copy);
    },
    undoneByJob() {
      const since = now() - UNDONE_WINDOW_MS;
      const out      = {};
      for (const row of ordered()) {
        if (row.status !== "ok" || row.doneAtMs !== null || row.createdAtMs < since) continue;
        (out[row.jobId] = out[row.jobId] || []).push(row.createdAtMs);
      }
      for (const jobId of Object.keys(out)) out[jobId] = out[jobId].slice(-UNDONE_MAX);
      return out;
    },

    actOnReminder(id        , againAtMs                = null) {
      const target = state.results.find((r     ) => r.id === id);
      if (!target || target.status !== "ok") return null;
      const stamp = now();
      for (const row of state.results) {
        if (row.jobId === target.jobId && row.status === "ok" && row.seq <= target.seq && row.doneAtMs === null) {
          row.doneAtMs = stamp;
          if (row.ackedAtMs === null) row.ackedAtMs = stamp;
        }
        if (row.jobId === target.jobId) row.againAtMs = null;
      }
      if (againAtMs !== null) target.againAtMs = againAtMs;
      save();
      return copy(target);
    },
    nextAgainAt() {
      const due = state.results.map((row     ) => row.againAtMs).filter((ms     ) => Number.isSafeInteger(ms));
      return due.length ? Math.min(...due) : null;
    },

    fireAgains() {
      const stamp = now();
      const due = ordered().filter((row) => Number.isSafeInteger(row.againAtMs) && row.againAtMs <= stamp);
      const copies = [];
      for (const original of due) {
        const live = state.results.find((r     ) => r.id === original.id);
        if (live) live.againAtMs = null;
        copies.push(copy(insert({ ...original, error: null, createdAtMs: stamp, runAtMs: null, runId: null })));
      }
      if (copies.length) save();
      return copies;
    },

    dropJob(jobId        ) {
      const before = state.results.length;
      state.results = state.results.filter((row     ) => row.jobId !== jobId);
      delete state.jobs[jobId];
      save();
      return before - state.results.length;
    },

    moveJob(oldId        , newId        ) {
      let moved = 0;
      const before = state.results.length;
      state.results = state.results.filter((row     ) => row.jobId !== oldId || row.ackedAtMs !== null);
      const dropped = before - state.results.length;
      for (const row of state.results) {
        if (row.jobId !== oldId) continue;
        row.jobId = newId;
        moved += 1;
      }
      delete state.jobs[oldId];
      save();
      return { moved, dropped };
    },
    jobIds() {
      return Object.keys(state.jobs);
    },
  };
}

function createOpenClawTaskResults(opts      = {}) {
  const previous = (globalThis       )[SINGLETON];
  if (previous && typeof previous.dispose === "function") previous.dispose();
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const enabled = typeof opts.enabled === "function" ? opts.enabled : () => false;
  const ctx = opts.ctx || null;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const store = createOpenClawTaskResultStore({ stateDir: opts.stateDir, fs: opts.fs, now });
  const kept = new Map             ();

  const owned = new Map             ();

  const running = new Map                ();
  let disposed = false;
  let againTimer      = null;
  let sweepTimer      = null;
  let sweeping                         = null;
  let changePending = false;

  const on = () => {
    if (disposed) return false;
    try {
      return enabled() === true;
    } catch (_) {
      return false;
    }
  };
  const warn = (message        ) => {
    if (opts.logger && typeof opts.logger.warn === "function") opts.logger.warn(`[openclaw-task-results] ${message}`);
  };
  const info = (message        ) => {
    if (opts.logger && typeof opts.logger.info === "function") opts.logger.info(message);
  };

  const alertRunEnd = (jobId        , run     ) => {
    if (typeof opts.alertRunEnd !== "function") return null;
    try {
      return opts.alertRunEnd(jobId, run);
    } catch (_) {
      return null;
    }
  };
  const noteDeclared = (jobId        , toolFailures     ) => {
    if (!toolFailures || !toolFailures.length) info(`[openclaw-task-results] disagree job=${jobId} agent=failed failedGroups=0`);
  };

  function changed() {
    if (changePending || typeof opts.onRunChanged !== "function") return;
    changePending = true;
    queueMicrotask(() => {
      changePending = false;
      if (!on()) return;
      try {
        opts.onRunChanged();
      } catch (err     ) {
        warn(`run change notice failed: ${err && err.message ? err.message : err}`);
      }
    });
  }

  function setRunning(jobId        , atMs               ) {
    const fresh = atMs !== null && now() - atMs < RUNNING_STALE_MS ? Math.trunc(atMs) : null;
    if (fresh === null ? !running.delete(jobId) : running.get(jobId) === fresh) return;
    if (fresh !== null) running.set(jobId, fresh);
    changed();
  }

  function noteLastRun(jobId        , task     , lastRun     ) {
    try {
      if (store.setLastRun(jobId, lastRun, task && task.name)) changed();
    } catch (err     ) {
      warn(`run facts not kept: ${err && err.message ? err.message : err}`);
    }
  }

  const signIns = new Map             ();
  const usageTimers = new Set     ();
  const SIGN_IN_FRESH_MS = 5 * 60_000;
  const RUN_LOG_WAITS_MS = [0, 5_000, 15_000];

  async function signInOf(agentId        , provider     ) {
    if (!ctx || ctx.connected?.() !== true || !ctx.advertises?.("models.authStatus")) return null;
    let kept = signIns.get(agentId);
    if (!kept || now() - kept.atMs >= SIGN_IN_FRESH_MS) {
      try {
        kept = { atMs: now(), reply: await ctx.call("models.authStatus", { agentId }) };
      } catch (err     ) {
        warn(`sign-in unread: ${err && err.message ? err.message : err}`);
        kept = { atMs: now(), reply: null };
      }
      signIns.set(agentId, kept);
    }
    return openClawSignInKind(kept.reply, provider);
  }

  function noteUsage(jobId        , endedAtMs        , usage     ) {
    try {
      if (store.setLastRunUsage(jobId, endedAtMs, usage)) changed();
    } catch (err     ) {
      warn(`run usage not kept: ${err && err.message ? err.message : err}`);
    }
  }

  function later(fn            , ms        ) {
    const timer = setTimeoutFn(() => {
      usageTimers.delete(timer);
      if (!disposed) fn();
    }, ms);
    usageTimers.add(timer);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  const pause = (ms        ) => new Promise      ((resolve) => later(resolve, ms));

  async function runLogEntry(jobId        , run     ) {
    if (!ctx || !ctx.advertises?.("cron.runs")) return null;

    if (typeof run.provider !== "string" && typeof run.sessionId !== "string") return null;
    const at = finite(run.runAtMs);
    for (const wait of RUN_LOG_WAITS_MS) {
      if (wait) await pause(wait);
      if (disposed || !on() || ctx.connected?.() !== true) return null;
      try {
        const reply      = await ctx.call("cron.runs", { id: jobId, limit: 10, sortDir: "desc" });
        const entry = (Array.isArray(reply?.entries) ? reply.entries : []).find((row     ) => record(row) &&
          (row.action === undefined || row.action === "finished") &&
          ((at !== null && finite(row.runAtMs) === at) ||
            (typeof run.sessionId === "string" && run.sessionId && row.sessionId === run.sessionId)));
        if (entry && openClawRunUsage(entry, null)) return { ...entry, sessionKey: entry.sessionKey ?? run.sessionKey };
      } catch (err     ) {
        warn(`run log unread: ${err && err.message ? err.message : err}`);
        return null;
      }
    }
    return null;
  }

  async function followUsage(jobId        , given     , endedAtMs        ) {

    const run = openClawRunUsage(given, null) ? given : await runLogEntry(jobId, given);
    const usage = run ? openClawRunUsage(run, null) : null;
    const key = run ? cronRunKey(run.sessionKey) : null;
    if (!usage || !key) return;
    noteUsage(jobId, endedAtMs, usage);
    const sessionId = typeof run.sessionId === "string" && run.sessionId ? run.sessionId : key.sessionId;
    const kind = await signInOf(key.agentId, run.provider);
    if (kind === "subscription") {
      noteUsage(jobId, endedAtMs, openClawRunUsage(run, kind));
      return;
    }
    if (kind !== "api_key" || !sessionId) return;
    const read = async (tries        ) => {
      if (!on() || ctx.connected?.() !== true) return;
      let usd                = null;
      try {
        usd = openClawSessionCost(await ctx.call("sessions.usage", { key: key.jobKey }), sessionId);
      } catch (err     ) {
        warn(`run cost unread: ${err && err.message ? err.message : err}`);
      }
      if (usd !== null) noteUsage(jobId, endedAtMs, { ...usage, cost: "estimated", usd });
      else if (tries + 1 < OPENCLAW_RUN_COST_TRIES) later(() => void read(tries + 1), OPENCLAW_RUN_COST_RETRY_MS);
    };
    later(() => void read(0), OPENCLAW_RUN_COST_SETTLE_MS);
  }

  function runFactsOf(jobId        ) {
    const since = running.get(jobId);
    const runningSinceMs = since !== undefined && now() - since < RUNNING_STALE_MS ? since : null;
    const lastRun = store.lastRun(jobId);
    return runningSinceMs === null && lastRun === null ? null : { runningSinceMs, lastRun };
  }

  async function push(rows       ) {
    const list = rows.slice(0, PUSH_MAX);
    if (!list.length || typeof opts.push !== "function") return 0;
    const params      = { results: list.map(pushWire) };
    const cards      = {};
    for (const row of list) if (row.status === "ok" && record(row.card)) cards[row.id] = row.card;
    if (Object.keys(cards).length) params.cards = cards;
    try {
      const reply      = await opts.push(params);
      return record(reply) && reply.ok === true && Number.isSafeInteger(reply.sent) ? reply.sent : 0;
    } catch (err     ) {
      warn(`push failed: ${err && err.message ? err.message : err}`);
      return 0;
    }
  }

  function pruneKept() {
    const oldest = now() - KEPT_TTL_MS;
    for (const [key, entry] of kept) if (entry.at < oldest) kept.delete(key);
    while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value          );
  }

  function noteFinalize(event     , hookCtx      = null) {
    if (!on()) return;
    const sessionKey = (record(event) && typeof event.sessionKey === "string" && event.sessionKey) ||
      (record(hookCtx) && typeof hookCtx.sessionKey === "string" && hookCtx.sessionKey) || "";
    if (!cronJobOfSessionKey(sessionKey) || !record(event) || typeof event.lastAssistantMessage !== "string") return;
    kept.delete(sessionKey);
    kept.set(sessionKey, { text: event.lastAssistantMessage, at: now() });
    pruneKept();
  }

  function toolFailuresOf(sessionKey        , sinceMs               ) {
    if (!sessionKey || typeof opts.toolFailuresOf !== "function") return null;
    try {
      return validTaskToolFailures(opts.toolFailuresOf(sessionKey, sinceMs));
    } catch (err     ) {
      warn(`tool failures unread: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  function toolsRanOf(sessionKey        )                 {
    if (!sessionKey || typeof opts.toolsRanOf !== "function") return null;
    try {
      const ran = opts.toolsRanOf(sessionKey);
      return typeof ran === "boolean" ? ran : null;
    } catch (_) {
      return null;
    }
  }

  const runKeyOf = (jobId        , run     ) => {
    const at = finite(run.runAtMs) ?? finite(run.ts);
    return at === null ? null : `${jobId}:${at}`;
  };

  function hostText(run     ) {
    for (const value of [run.error, run.summary, run.reason]) {
      if (typeof value === "string" && value.trim()) return value.slice(0, ERROR_MAX * 2);
    }
    const terminal = record(run.agentTerminal) ? run.agentTerminal : null;
    const parts = terminal
      ? Object.values(terminal).filter((v     ) => typeof v === "string" && v.trim()).map((v     ) => v.trim())
      : [];
    return parts.length ? parts.join(" · ").slice(0, ERROR_MAX * 2) : null;
  }

  function hostStatusOf(run     ) {
    if (run.deliveryStatus === "not-delivered" && run.completionStatus === "failed") return "not-delivered";
    const stop = record(run.agentTerminal) ? String(run.agentTerminal.stopReason || "") : "";
    if (/time ?out|timed[_ ]?out|deadline/i.test(stop)) return "timeout";
    return typeof run.status === "string" ? run.status : null;
  }

  function busyRetryAt(text     , job     , endedAtMs        ) {
    if (classifyTaskFailure(null, text).reason !== "ai_busy") return null;
    const next = finite(record(job) && record(job.state) ? job.state.nextRunAtMs : null);
    return next !== null && next > endedAtMs && next - endedAtMs <= BUSY_RETRY_WITHIN_MS ? Math.trunc(next) : null;
  }

  function skipWhy(text     ) {
    const reason = typeof text === "string" ? text : "";
    if (/already running|still running|overlap|in progress|concurren/i.test(reason)) return "overlap";
    if (/preflight|provider|model|unreachable|not reachable|offline|unavailable/i.test(reason)) return "preflight";
    return "other";
  }

  function capture(jobId        , task     , run     , job      = null) {
    const runKey = runKeyOf(jobId, run);
    if (runKey === null || store.seen(jobId, runKey)) return null;
    const sessionKey = typeof run.sessionKey === "string" ? run.sessionKey : "";
    const keptText = sessionKey && kept.has(sessionKey) ? kept.get(sessionKey).text : null;
    if (sessionKey) kept.delete(sessionKey);
    const runAtMs = finite(run.runAtMs);
    const durationMs = finite(run.durationMs);
    const createdAtMs = Math.trunc(runAtMs !== null && durationMs !== null ? runAtMs + durationMs : finite(run.ts) ?? now());
    const base = {
      jobId, jobName: task.name || null, taskId: task.taskId || null, createdAtMs,
      runAtMs: runAtMs === null ? null : Math.trunc(runAtMs),
      runId: typeof run.runId === "string" ? run.runId.slice(0, ID_MAX) : null,
    };
    const startedAtMs = base.runAtMs !== null && base.runAtMs <= createdAtMs ? base.runAtMs : null;

    const ranTools = toolsRanOf(sessionKey);

    const toolFailures = toolFailuresOf(sessionKey, startedAtMs);

    const guessed = ranTools === false && taskRunHeld(toolFailures);

    const runUsage = openClawRunUsage(run, null);
    const took = runUsage ? { usage: runUsage } : {};
    const follow = () => void followUsage(jobId, run, createdAtMs).catch((err     ) =>
      warn(`run usage failed: ${err && err.message ? err.message : err}`));
    let fields     ;
    let lastRun     ;
    if (run.status === "error") {
      const text = hostText(run);
      fields = { ...base, status: "failed", truncated: false, ...failedRun(text, task.name) };
      lastRun = {
        outcome: "failed", startedAtMs, endedAtMs: createdAtMs, hostStatus: hostStatusOf(run), error: text,
        retryAtMs: busyRetryAt(text, job, createdAtMs), ...took,
      };
    } else if (run.status === "ok") {

      const { text, state: alertState } = splitAlertState(keptText ?? (typeof run.summary === "string" ? run.summary : ""));
      const silent = isSilentAnswer(text) || run.deliverySuppressionReason === "empty";

      if (!silent && guessed && agentDeclaredFailure(text) === null && hostRefusedRun(text) === null) {
        store.markSeen(jobId, runKey);
        noteLastRun(jobId, task, { outcome: "ok", startedAtMs, endedAtMs: createdAtMs, ...took });
        info(`[openclaw-task-results] held answer job=${jobId} leftOut=${toolFailures ? toolFailures.length : 0}`);
        follow();
        return null;
      }
      const alertVerdict = alertRunEnd(jobId, { state: alertState, silent });

      if (silent || alertVerdict === "quiet" || alertVerdict === "same") {
        store.markSeen(jobId, runKey);
        noteLastRun(jobId, task, { outcome: "quiet", startedAtMs, endedAtMs: createdAtMs, ...took });
        follow();
        return null;
      }

      const declared = agentDeclaredFailure(text);

      const hostRefusal = declared === null ? hostRefusedRun(text) : null;

      const heldRefusal = hostRefusal !== null && taskRunHeld(toolFailures) ? hostRefusal : null;
      const refused = heldRefusal === null ? hostRefusal : null;
      if (refused !== null) {
        fields = { ...base, status: "failed", truncated: false, ...failedRun(refused, task.name), toolFailures };
        lastRun = { outcome: "failed", startedAtMs, endedAtMs: createdAtMs, hostStatus: "host_refused", error: refused, ...took };
        info(`[openclaw-task-results] host_refused job=${jobId}`);
      } else if (declared !== null || heldRefusal !== null) {
        const line = declared !== null ? declared : heldRefusal;
        fields = { ...base, status: "failed", truncated: false, ...failedRun(line, task.name), toolFailures };
        lastRun = {
          outcome: "failed", startedAtMs, endedAtMs: createdAtMs, hostStatus: "agent_failure", error: line,
          toolSignIn: soleToolSignIn(toolFailures), ...took,

          ...(taskRunHeld(toolFailures) ? { held: true } : {}),
        };
        if (declared !== null) noteDeclared(jobId, toolFailures);
        else info(`[openclaw-task-results] held refusal job=${jobId}`);
      } else {
        const parsed = parseRunAnswer(text, task.name);
        fields = { ...base, status: "ok", error: null, truncated: keptText === null && chars(text).length >= SUMMARY_CUT,
          ...parsed, toolFailures };
        lastRun = { outcome: "ok", startedAtMs, endedAtMs: createdAtMs, ...took };
        if (toolFailures && toolFailures.length) {

          info(`[openclaw-task-results] disagree job=${jobId} agent=ok failedGroups=${toolFailures.length}`);
        }
      }
    } else if (run.status === "skipped") {

      const text = hostText(run);
      store.markSeen(jobId, runKey);
      noteLastRun(jobId, task, {
        outcome: "skipped", startedAtMs, endedAtMs: createdAtMs, hostStatus: "skipped", error: text,
        skippedWhy: skipWhy(text),
      });
      return null;
    } else {
      return null;
    }
    const stored = store.record(fields, runKey);
    if (stored) {
      noteLastRun(jobId, task, lastRun);
      follow();
    }
    return stored;
  }

  function handTestAnswer(jobId        , run     ) {
    const sessionKey = typeof run.sessionKey === "string" ? run.sessionKey : "";
    const keptText = sessionKey && kept.has(sessionKey) ? kept.get(sessionKey).text : null;
    if (sessionKey) kept.delete(sessionKey);

    if (sessionKey) toolFailuresOf(sessionKey, null);
    let params     ;
    if (run.status === "ok") {
      const text = keptText ?? (typeof run.summary === "string" ? run.summary : "");
      if (isSilentAnswer(text) || run.deliverySuppressionReason === "empty") {
        params = { jobId, failed: false, headline: "", body: "" };
      } else {
        const parsed = parseRunAnswer(text, null);
        params = { jobId, failed: false, headline: parsed.headline, body: parsed.body,
          ...(record(parsed.card) ? { card: parsed.card } : {}) };
      }
    } else {

      const text = hostText(run);
      const failed = failedRun(text === null ? null : redactHostText(text), null);
      params = { jobId, failed: true, headline: failed.headline, body: failed.body };
    }
    if (typeof opts.onTestResult !== "function") return;
    try {
      opts.onTestResult(params);
    } catch (err     ) {
      warn(`test answer failed: ${err && err.message ? err.message : err}`);
    }
  }

  function dropTestJob(jobId        ) {
    if (typeof jobId !== "string" || !jobId) return;
    for (const key of [...kept.keys()]) if (cronJobOfSessionKey(key) === jobId) kept.delete(key);
  }

  function noteCronChanged(event     ) {
    if (!on() || !record(event) || typeof event.jobId !== "string") return;
    const jobId = event.jobId;
    if (event.action === "removed") {
      owned.delete(jobId);
      setRunning(jobId, null);
      return;
    }

    if (record(event.job) && testIdOfJob(event.job)) {
      if (event.action === "finished") handTestAnswer(jobId, event);
      return;
    }
    const taskId = record(event.job) ? taskIdOfJob(event.job) : owned.get(jobId)?.taskId ?? null;
    if (!taskId) return;
    const name = record(event.job) && typeof event.job.name === "string" ? event.job.name : owned.get(jobId)?.name ?? null;
    owned.set(jobId, { taskId, name });
    if (event.action === "started") {
      const at = finite(event.runAtMs) ?? finite(record(event.job) && record(event.job.state) ? event.job.state.runningAtMs : null);
      setRunning(jobId, at ?? now());
      return;
    }
    if (event.action !== "finished") return;
    setRunning(jobId, null);
    if (store.cursor(jobId) === null) store.setCursor(jobId, Math.max(0, (finite(event.runAtMs) ?? now()) - 1));
    const stored = capture(jobId, { taskId, name }, event, record(event.job) ? event.job : null);
    if (stored) void push([stored]);
  }

  function noteOwned(jobId        , taskId        ) {
    if (typeof jobId !== "string" || !jobId) return;
    owned.set(jobId, { taskId, name: owned.get(jobId)?.name ?? null });
    store.setCursor(jobId, now());
  }

  function dropJob(jobId        ) {
    if (typeof jobId !== "string" || !jobId) return;
    owned.delete(jobId);
    running.delete(jobId);
    try {
      store.dropJob(jobId);
    } catch (err     ) {
      warn(`drop failed: ${err && err.message ? err.message : err}`);
    }
  }

  function moveJob(oldId        , newId        ) {
    if (typeof oldId !== "string" || !oldId || typeof newId !== "string" || !newId) return;
    owned.delete(oldId);
    running.delete(oldId);
    try {
      store.moveJob(oldId, newId);
    } catch (err     ) {
      warn(`move failed: ${err && err.message ? err.message : err}`);
    }
  }

  async function ownedJobs() {
    const out        = [];
    for (let page = 0; page < 5; page += 1) {
      const reply      = await ctx.call("cron.list", { includeDisabled: true, limit: 200, offset: page * 200,
        includeDeliveryPreviews: false });
      const rows = Array.isArray(reply?.jobs) ? reply.jobs : [];
      for (const job of rows) {
        const taskId = taskIdOfJob(job);
        if (!taskId || typeof job.id !== "string") continue;
        const state = record(job.state) ? job.state : {};

        out.push({ jobId: job.id, taskId, name: job.name || null, runningAtMs: finite(state.runningAtMs),
          nextRunAtMs: finite(state.nextRunAtMs) });
      }
      if (reply?.hasMore !== true || rows.length === 0) break;
    }
    return out;
  }

  function sweep()                  {
    if (!on() || !ctx || ctx.connected?.() !== true || !ctx.advertises?.("cron.runs") || !ctx.advertises?.("cron.list")) {
      return Promise.resolve(0);
    }
    if (sweeping) return sweeping;
    sweeping = (async () => {
      const fresh        = [];
      try {
        for (const job of await ownedJobs()) {
          owned.set(job.jobId, { taskId: job.taskId, name: job.name });

          setRunning(job.jobId, job.runningAtMs);
          let cursor = store.cursor(job.jobId);

          if (cursor === null) {
            store.setCursor(job.jobId, now());
            continue;
          }
          const reply      = await ctx.call("cron.runs", { id: job.jobId, limit: RUNS_PAGE, sortDir: "desc" });
          const runs = (Array.isArray(reply?.entries) ? reply.entries : [])
            .filter((run     ) => record(run) && (run.action === undefined || run.action === "finished"))
            .reverse();
          for (const run of runs) {
            const at = finite(run.runAtMs) ?? finite(run.ts);
            if (at === null || at <= cursor) continue;
            const stored = capture(job.jobId, job, run, { state: { nextRunAtMs: job.nextRunAtMs } });
            if (stored) fresh.push(stored);
            cursor = Math.max(cursor, Math.trunc(at));
          }
          store.setCursor(job.jobId, cursor);
        }
      } catch (err     ) {
        warn(`sweep failed: ${err && err.message ? err.message : err}`);
      }
      if (fresh.length) await push(fresh);
      return fresh.length;
    })().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  function armAgain() {
    if (againTimer !== null) {
      clearTimeoutFn(againTimer);
      againTimer = null;
    }
    if (!on()) return;
    const at = store.nextAgainAt();
    if (at === null) return;
    againTimer = setTimeoutFn(() => {
      againTimer = null;
      void fireAgains();
    }, Math.max(0, at - now()));
    if (againTimer && typeof againTimer.unref === "function") againTimer.unref();
  }

  async function fireAgains() {
    if (!on()) return 0;
    let copies        = [];
    try {
      copies = store.fireAgains();
    } catch (err     ) {
      warn(`again failed: ${err && err.message ? err.message : err}`);
    }
    if (copies.length) await push(copies);
    armAgain();
    return copies.length;
  }

  function start() {
    if (disposed || sweepTimer !== null || !on()) return;
    sweepTimer = setIntervalFn(() => void sweep(), SWEEP_EVERY_MS);
    if (sweepTimer && typeof sweepTimer.unref === "function") sweepTimer.unref();
    armAgain();
    void sweep();
  }

  const methods      = {
    "task.result.unacked": () => {
      armAgain();
      void sweep();
      return { ok: true, results: store.listUnacked().slice(-PUSH_MAX).map(pushWire) };
    },
    "task.result.ack": (params     ) => {
      const id = record(params) ? params.resultId : null;
      if (typeof id !== "string" || !RESULT_ID.test(id)) return { ok: false, error: "invalid_params" };
      return { ok: true, acked: store.ack(id) };
    },
    "task.result.latest": () => {
      armAgain();
      const undone = store.undoneByJob();
      const listed = new Set        ();
      const jobs        = store.latestByJob().slice(0, LATEST_MAX).map(([ok, failed]     ) => {
        const jobId = (ok || failed).jobId;
        listed.add(jobId);
        return latestWire(ok, failed, undone[jobId], runFactsOf(jobId));
      });

      for (const jobId of new Set([...running.keys(), ...store.jobIds()])) {
        if (listed.has(jobId) || jobs.length >= LATEST_MAX) continue;
        const run = runFactsOf(jobId);
        if (run) jobs.push(runOnlyWire(jobId, owned.get(jobId)?.name ?? store.jobName(jobId), run));
      }
      return { ok: true, jobs };
    },

    "taskOutput.snapshot": (params     ) => {
      const ids = record(params) && Array.isArray(params.jobIds) ? params.jobIds : [];
      const jobs = ids.filter((id     ) => typeof id === "string" && id && id.length <= ID_MAX && !/[\u0000-\u001f\u007f]/.test(id))
        .slice(0, TASK_OUTPUT_JOBS_MAX)
        .map((jobId        ) => {
          const row = store.recentForJob(jobId, 1)[0] || null;
          return {
            jobId,
            result: row ? {
              status: row.status,
              headline: row.headline,
              body: typeof row.body === "string" ? row.body.slice(0, TASK_OUTPUT_BODY_CHARS) : "",
              card: record(row.card) ? row.card : null,
              createdAtMs: row.createdAtMs,
              truncated: row.truncated === true,
            } : null,
            cronLog: null,
          };
        });
      return { contract: "ocuclaw.task-output-snapshot", contractVersion: 1, jobs };
    },
    "task.result.recent": (params     ) => {
      const jobId = record(params) ? params.jobId : null;
      if (typeof jobId !== "string" || !jobId || jobId.length > ID_MAX || /[\u0000-\u001f\u007f]/.test(jobId)) {
        return { ok: false, error: "invalid_params" };
      }
      return {
        ok: true,
        results: store.recentForJob(jobId).map((row     ) => {
          const out      = { ...pushWire(row), error: row.status === "failed" ? pageError(row.error) : null };
          if (row.status === "ok" && Number.isSafeInteger(row.ackedAtMs) && row.createdAtMs <= row.ackedAtMs) {
            out.ackedAtMs = row.ackedAtMs;
          }
          return out;
        }),
      };
    },
    "task.result.reminder": (params     ) => {
      const id = record(params) ? params.resultId : null;
      const action = record(params) ? params.action : null;
      if (typeof id !== "string" || !RESULT_ID.test(id) || (action !== "done" && action !== "again")) {
        return { ok: false, error: "invalid_params" };
      }
      const againAt = action === "again" ? now() + AGAIN_DELAY_MS : null;
      const acted = store.actOnReminder(id, againAt);
      if (!acted) return { ok: true, found: false };
      armAgain();
      return { ok: true, found: true, ...(againAt !== null ? { againAtMs: againAt } : {}) };
    },
  };

  const link = {
    request(method        , params      = {}) {
      if (!on()) return Promise.resolve({ ok: false, error: "unavailable" });
      const handler = methods[method];
      if (typeof handler !== "function") return Promise.resolve({ ok: false, error: "unknown_method" });
      try {
        return Promise.resolve(handler(params));
      } catch (err     ) {
        warn(`${method} failed: ${err && err.message ? err.message : err}`);
        return Promise.resolve({ ok: false, error: "store_unavailable" });
      }
    },
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (againTimer !== null) clearTimeoutFn(againTimer);
    if (sweepTimer !== null) clearIntervalFn(sweepTimer);
    againTimer = null;
    sweepTimer = null;
    for (const timer of usageTimers) clearTimeoutFn(timer);
    usageTimers.clear();
    kept.clear();
    running.clear();
    if ((globalThis       )[SINGLETON] === api) delete (globalThis       )[SINGLETON];
  }

  const api = { link, noteFinalize, noteCronChanged, noteOwned, dropJob, moveJob, dropTestJob, sweep, start, fireAgains, dispose, store };
  (globalThis       )[SINGLETON] = api;
  return api;
}

module.exports = { OPENCLAW_TASK_RESULTS_FILE, RECENT_LIMIT, LATEST_JOBS_LIMIT, CARD_MAX_BYTES, HEADLINE_MAX, BODY_MAX, ERROR_MAX, DEFAULT_HEADLINE, AGAIN_DELAY_MS, clip, parseCard, isSilentAnswer, parseRunAnswer, failedRun, displayLine, pushWire, createOpenClawTaskResultStore, createOpenClawTaskResults };
