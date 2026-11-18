const nodeFs = require("node:fs");
const path = require("node:path");

const { atomicWriteLiveuiLibraryRecord, isValidLiveuiLibraryItemId, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { hasTaskUnchecked, taskUncheckedDataAtMs } = require("./glasses-ui-task-unchecked.cjs");
const { bindingSlot } = require("./glasses-ui-task-slots.cjs");
const { carryUnknownFields, hasUnknownFields } = require("./saved-format.cjs");

const TASK_OPEN_UPDATE_DIR = "task-open-update-v1";

const TASK_OPEN_UPDATE_SIM_FILE = "task-open-update-sim-allow-v1.json";
const TASK_OPEN_UPDATE_STALE_CHOICES_MS = Object.freeze([15 * 60_000, 60 * 60_000, 3 * 60 * 60_000, 24 * 60 * 60_000]);
const TASK_OPEN_UPDATE_DEFAULT_STALE_MS = 60 * 60_000;
const TASK_AGENT_REFRESH_CAP_CHOICES = Object.freeze([1, 3, 6, 12, 24]);

const TASK_AGENT_REFRESH_DEFAULT_CAP = 6;
const TASK_OPEN_UPDATE_WEEK_MS = 7 * 24 * 60 * 60_000;

const TASK_OPEN_UPDATE_PENDING_MAX_MS = 10 * 60_000;

const UNCHECKED_CODE = "unchecked";

const TASK_AGENT_REFRESH_CAP_REASON = "agent_refresh_cap: this card's Task already ran the most agent refreshes its owner allows today. It resets at midnight. Ask the wearer to tap Refresh if they want it now.";

const OPEN_RUNS_KEPT = 64;

const OPEN_RUN_UNSAVED = "open_run_unsaved";

const JOB_NEVER_STARTED_CODES = new Set([

  "task_schedule_none", "task_schedule_unsupported", "task_schedule_unavailable",
  "task_schedule_job_missing", "task_schedule_job_not_owned", "task_schedule_job_owned", "task_schedule_job_paused",
  "task_schedule_job_no_prompt", "task_schedule_run_not_started", "task_schedule_invalid_request",
  "task_schedule_invalid_scope", "task_schedule_profile_not_served", "task_schedule_management_unavailable",
]);

const TASK_OPEN_UPDATE_UNKNOWN_CHECK_MS = 3 * 60_000;

function resultOfOpenRun(result     , atMs        ) {
  if (!isPlainObject(result)) return false;
  const began = finiteMs(result.runAtMs);
  if (began !== null) return began >= atMs - 1000;
  const ended = finiteMs(result.createdAtMs);
  return ended !== null && ended >= atMs;
}

function jobNeverStarted(result     ) {
  if (!isPlainObject(result)) return false;
  if (result.status === "accepted") return result.state === "job_missing";
  return result.status === "rejected" && JOB_NEVER_STARTED_CODES.has(result.code);
}

function isPlainObject(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteMs(value     )                {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function taskOpenUpdateDayKey(ms        ) {
  const day = new Date(ms);
  const pad = (n        ) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function defaultRecord(taskId        ) {
  return {
    schemaVersion: 1,
    taskId,
    on: false,
    staleMs: TASK_OPEN_UPDATE_DEFAULT_STALE_MS,
    agentCap: TASK_AGENT_REFRESH_DEFAULT_CAP,
    openRuns: []            ,
    agentDay: null                 ,
    agentCount: 0,
    pending: null       ,
    failedAtMs: null                 ,
    failedCode: null                 ,
  };
}

const TASK_OPEN_UPDATE_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "taskId", "on", "staleMs", "agentCap", "openRuns", "agentDay", "agentCount", "pending",
    "failedAtMs", "failedCode"],
  parts: { pending: { replaced: true, fields: ["atMs", "via"] } },
});

function validRecord(raw     , taskId        ) {
  const record = defaultRecord(taskId);
  if (!isPlainObject(raw) || raw.schemaVersion !== 1 || raw.taskId !== taskId) return record;
  record.on = raw.on === true;
  if (TASK_OPEN_UPDATE_STALE_CHOICES_MS.includes(raw.staleMs)) record.staleMs = raw.staleMs;
  if (TASK_AGENT_REFRESH_CAP_CHOICES.includes(raw.agentCap)) record.agentCap = raw.agentCap;
  if (Array.isArray(raw.openRuns)) record.openRuns = raw.openRuns.filter((ms     ) => finiteMs(ms) !== null).slice(-OPEN_RUNS_KEPT);
  if (typeof raw.agentDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.agentDay) && Number.isSafeInteger(raw.agentCount) &&
      raw.agentCount >= 0) {
    record.agentDay = raw.agentDay;
    record.agentCount = raw.agentCount;
  }
  if (isPlainObject(raw.pending) && finiteMs(raw.pending.atMs) !== null && ["job", "feed"].includes(raw.pending.via))
    record.pending = { atMs: raw.pending.atMs, via: raw.pending.via };
  if (finiteMs(raw.failedAtMs) !== null) {
    record.failedAtMs = raw.failedAtMs;
    record.failedCode = typeof raw.failedCode === "string" ? raw.failedCode.slice(0, 64) : null;
  }
  return record;
}

function taskMayUpdateOnOpen(taskId        , opts      = {})                                               {
  const kind = typeof opts.kind === "function" ? opts.kind(taskId) : null;
  if (kind === "reminder" || kind === "alert") return { ok: false, why: "not_brief" };
  if (typeof opts.hostEnforces === "function" && opts.hostEnforces(taskId) === true) return { ok: true };
  if (typeof opts.simAllows === "function" && opts.simAllows(taskId) === true) return { ok: true, sim: true };
  return { ok: false, why: "host_cannot_enforce" };
}

function decideTaskOpenUpdate({ settings, gate, dataAtMs, nowMs, running, failedAtMs }     ) {
  if (!settings || settings.on !== true) return { state: "off", start: false };
  if (!gate || gate.ok !== true) return { state: "off", start: false, code: gate?.why || "host_cannot_enforce" };
  const ageMs = Number.isFinite(dataAtMs) ? Math.max(0, nowMs - dataAtMs) : Infinity;
  if (ageMs <= settings.staleMs) return { state: "fresh", start: false };
  if (running) return { state: "updating", start: false };
  if (Number.isFinite(failedAtMs) && nowMs - failedAtMs < settings.staleMs)
    return { state: "failed", start: false, atMs: failedAtMs };
  return { state: "updating", start: true };
}

function createTaskOpenUpdateStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const dir = path.join(libraryDir, TASK_OPEN_UPDATE_DIR);
  const simFile = path.join(libraryDir, TASK_OPEN_UPDATE_SIM_FILE);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
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

    let before      = null;
    try {
      before = JSON.parse(fs.readFileSync(fileFor(record.taskId), "utf8"));
    } catch (_) {
      before = null;
    }
    const kept = isPlainObject(before) && before.schemaVersion === 1 && before.taskId === record.taskId &&
      hasUnknownFields(before, TASK_OPEN_UPDATE_SAVED_SHAPE)
      ? carryUnknownFields(before, record, TASK_OPEN_UPDATE_SAVED_SHAPE)
      : record;
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: fileFor(record.taskId), record: kept }).status === "written";
  }

  function update(taskId     , change                       ) {
    const record = read(taskId);
    if (!record) return null;
    change(record);
    return write(record) ? record : null;
  }

  return {
    dir,
    read,

    set(taskId     , input     ) {
      if (!isValidLiveuiLibraryItemId(taskId)) return { status: "rejected", code: "task_not_found" };
      if (!isPlainObject(input) || typeof input.on !== "boolean") return { status: "rejected", code: "open_update_invalid" };
      const staleMs = input.staleMs === undefined ? undefined : input.staleMs;
      const agentCap = input.agentCap === undefined ? undefined : input.agentCap;
      if (staleMs !== undefined && !TASK_OPEN_UPDATE_STALE_CHOICES_MS.includes(staleMs))
        return { status: "rejected", code: "open_update_invalid" };
      if (agentCap !== undefined && !TASK_AGENT_REFRESH_CAP_CHOICES.includes(agentCap))
        return { status: "rejected", code: "open_update_invalid" };
      const saved = update(taskId, (record) => {
        record.on = input.on;
        if (staleMs !== undefined) record.staleMs = staleMs;
        if (agentCap !== undefined) record.agentCap = agentCap;
      });
      return saved ? { status: "accepted", record: saved } : { status: "rejected", code: "open_update_save_failed" };
    },

    noteOpenRun(taskId     , via                , atMs         = now()) {
      return update(taskId, (record) => {
        record.openRuns = [...record.openRuns.filter((ms        ) => atMs - ms < TASK_OPEN_UPDATE_WEEK_MS + 86_400_000), atMs]
          .slice(-OPEN_RUNS_KEPT);
        record.pending = { atMs, via };
      });
    },

    forgetOpenRun(taskId     , atMs        ) {
      return update(taskId, (record) => {
        const at = record.openRuns.lastIndexOf(atMs);
        if (at >= 0) record.openRuns = [...record.openRuns.slice(0, at), ...record.openRuns.slice(at + 1)];
        if (record.pending && record.pending.atMs === atMs) record.pending = null;
      });
    },

    settleOpenRun(taskId     , { ok, code, atMs }      = {}) {
      const record = read(taskId);
      if (!record) return null;
      if (!record.pending && ok) return record;
      return update(taskId, (next) => {
        next.pending = null;
        if (!ok) {
          next.failedAtMs = finiteMs(atMs) ?? now();
          next.failedCode = typeof code === "string" ? code.slice(0, 64) : null;
        }
      });
    },

    weekRuns(taskId     , nowMs         = now()) {
      const record = read(taskId);
      return record ? record.openRuns.filter((ms        ) => ms <= nowMs && nowMs - ms < TASK_OPEN_UPDATE_WEEK_MS).length : 0;
    },

    pending(taskId     , nowMs         = now()) {
      const pending = read(taskId)?.pending;
      return pending && nowMs - pending.atMs < TASK_OPEN_UPDATE_PENDING_MAX_MS ? pending : null;
    },

    openRun(taskId     ) {
      return read(taskId)?.pending || null;
    },

    takeAgentRefresh(taskId     , nowMs         = now()) {
      const record = read(taskId);
      if (!record) return { ok: false, count: 0, cap: TASK_AGENT_REFRESH_DEFAULT_CAP };
      const day = taskOpenUpdateDayKey(nowMs);
      const used = record.agentDay === day ? record.agentCount : 0;
      if (used >= record.agentCap) return { ok: false, count: used, cap: record.agentCap };
      const saved = update(taskId, (next) => {
        next.agentDay = day;
        next.agentCount = used + 1;
      });
      return saved ? { ok: true, count: used + 1, cap: record.agentCap, day } : { ok: false, count: used, cap: record.agentCap };
    },

    giveBackAgentRefresh(taskId     , day     ) {
      const record = read(taskId);
      if (!record || typeof day !== "string" || record.agentDay !== day || record.agentCount < 1) return false;
      return !!update(taskId, (next) => {
        next.agentCount = Math.max(0, record.agentCount - 1);
      });
    },
    clear(taskId     ) {
      if (!isValidLiveuiLibraryItemId(taskId)) return false;
      try {
        fs.unlinkSync(fileFor(taskId));
        return true;
      } catch (_) {
        return false;
      }
    },

    simAllows(taskId     ) {
      try {
        const raw = JSON.parse(fs.readFileSync(simFile, "utf8"));
        return isPlainObject(raw) && Array.isArray(raw.taskIds) && raw.taskIds.includes(taskId);
      } catch (_) {
        return false;
      }
    },
  };
}

function createTaskOpenUpdate(opts      = {}) {
  const store = opts.store;
  const feed = opts.feed;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const logger = opts.logger || null;
  const send = typeof opts.send === "function" ? opts.send : () => {};
  const rowRun = typeof opts.rowRun === "function" ? opts.rowRun : async () => null;
  const activeTaskId = typeof opts.activeTaskId === "function" ? opts.activeTaskId : () => null;
  const hasJob = typeof opts.hasJob === "function" ? opts.hasJob : () => false;
  const runJobNow = typeof opts.runJobNow === "function" ? opts.runJobNow : null;
  const launchFeedRun = typeof opts.launchFeedRun === "function" ? opts.launchFeedRun : null;
  const taskKind = typeof opts.taskKind === "function" ? opts.taskKind : () => null;
  const hostEnforces = typeof opts.hostEnforces === "function" ? opts.hostEnforces : () => false;
  const setTimer = typeof opts.setTimeout === "function" ? opts.setTimeout : setTimeout;

  function gate(taskId        ) {
    return taskMayUpdateOnOpen(taskId, { kind: taskKind, hostEnforces, simAllows: (id        ) => store.simAllows(id) });
  }

  function frame(binding     , state        , extra      = {}) {
    return {
      type: "ocuclaw.program.open.state",
      v: 1,
      cardId: binding.cardId,
      taskId: binding.taskId,

      ...(binding.schemaVersion === 2 ? { slot: bindingSlot(binding) } : {}),
      state,
      dataAtMs: finiteMs(binding.last?.atMs),
      atMs: now(),
      ...extra,
    };
  }

  function fail(binding     , code        ) {
    const atMs = now();
    store.settleOpenRun(binding.taskId, { ok: false, code, atMs });
    logger?.info?.(`[program-card] open-run failed task=${binding.taskId} card=${binding.cardId} code=${code}`);
    send(JSON.stringify(frame(binding, "failed", { failedAtMs: atMs, code })), binding);
  }

  function settleDelivered(binding     ) {
    if (!hasTaskUnchecked(binding.last?.unchecked)) {
      store.settleOpenRun(binding.taskId, { ok: true });
      return;
    }
    store.settleOpenRun(binding.taskId, { ok: false, code: UNCHECKED_CODE, atMs: finiteMs(binding.last?.atMs) ?? now() });
    logger?.info?.(`[program-card] open-run left unchecked task=${binding.taskId} card=${binding.cardId} ` +
      `keys=${Object.keys(binding.last.unchecked).join(",")}`);
  }

  function checkUnknownStartOnce(taskId        , atMs        ) {
    const timer = setTimer(async () => {
      try {
        const live = store.openRun(taskId);
        if (!live || live.via !== "job" || live.atMs !== atMs) return;
        let row      = null;
        try { row = await rowRun(taskId); } catch (_) { return; }
        if (row && row.state === "running") return;
        const began = row ? finiteMs(row.startedAtMs) ?? finiteMs(row.endedAtMs) : null;
        if (began !== null && began >= atMs - 1000) return;
        const still = store.openRun(taskId);
        if (still && still.via === "job" && still.atMs === atMs) {
          store.forgetOpenRun(taskId, atMs);
          logger?.info?.(`[program-card] open-run job never started task=${taskId}: hold given back`);
        }
      } catch (_) {

      }
    }, TASK_OPEN_UPDATE_UNKNOWN_CHECK_MS);
    timer?.unref?.();
  }

  async function start(binding     , clientId        ) {
    const taskId = binding.taskId;
    if (runJobNow && hasJob(taskId)) {

      const atMs = now();
      if (!store.noteOpenRun(taskId, "job", atMs)) return { code: OPEN_RUN_UNSAVED };
      let result      = null;
      try { result = await runJobNow(taskId); } catch (_) { result = null; }

      if ((result && result.status === "accepted" && result.state !== "job_missing") ||
          result?.code === "task_schedule_already_running") {
        return { via: "job" };
      }

      if (!jobNeverStarted(result)) {
        logger?.info?.(`[program-card] open-run job outcome unknown task=${taskId} code=${result?.code || "none"}`);
        checkUnknownStartOnce(taskId, atMs);
        return { via: "job" };
      }

      store.forgetOpenRun(taskId, atMs);
    }
    if (!launchFeedRun) return { code: "executor_unavailable" };

    if (!store.noteOpenRun(taskId, "feed")) return { code: OPEN_RUN_UNSAVED };

    Promise.resolve(launchFeedRun({ clientId, cardId: binding.cardId,
      ...(binding.schemaVersion === 2 ? { slot: bindingSlot(binding) } : {}) })).then((result     ) => {
      if (result?.dropped === true && result.code === "card_closed") store.settleOpenRun(taskId, { ok: true });

      else if (!result || result.status !== "accepted") setTimeout(() => fail(binding, result?.code || "launch_failed"), 0);
    }).catch(() => setTimeout(() => fail(binding, "launch_failed"), 0));
    return { via: "feed" };
  }

  return {
    gate,

    projection(binding     ) {
      const record = store.read(binding.taskId);
      if (!record) return null;
      const allowed = gate(binding.taskId);
      return {
        on: record.on === true && allowed.ok,
        staleMs: record.staleMs,
        agentCap: record.agentCap,
        weekRuns: store.weekRuns(binding.taskId),
        allowed: allowed.ok,
        ...(allowed.ok ? {} : { why: allowed.why }),
      };
    },

    set(taskId        , input     ) {
      const result = store.set(taskId, input);
      if (result.status === "accepted")
        logger?.info?.(`[program-card] open update task=${taskId} on=${result.record.on} staleMs=${result.record.staleMs} agentCap=${result.record.agentCap}`);
      return result;
    },

    async opened({ clientId, cardId, owns }     ) {
      const bound = typeof cardId === "string" && cardId ? feed.store.forCard(cardId) : [];
      const parts = bound.filter((binding     ) => typeof owns !== "function" || owns(binding));
      if (!parts.length) return null;
      if (bound.length < 2) return openedPart(clientId, parts[0]);
      const frames        = [];
      for (const binding of parts) frames.push(await openedPart(clientId, binding));
      return frames;
    },

    onRunEnded(run     ) {
      if (!run || !run.feed || typeof run.taskId !== "string") return;

      const pending = store.openRun(run.taskId);
      if (!pending || pending.via !== "feed" || !Number.isFinite(run.startedAt) || run.startedAt < pending.atMs - 1000) return;
      const binding = feed.store.read(run.taskId);
      if (run.endedReason === "fed") binding ? settleDelivered(binding) : store.settleOpenRun(run.taskId, { ok: true });
      else if (binding) fail(binding, run.endedReason || "other");
      else store.settleOpenRun(run.taskId, { ok: false, code: run.endedReason || "other" });
    },

    onTaskResult({ taskId, result, outcome }     ) {

      const pending = store.openRun(taskId);
      if (!pending || pending.via !== "job") return;

      if (!resultOfOpenRun(result, pending.atMs)) return;
      if (outcome?.status === "delivered") {
        const binding = feed.store.read(taskId);
        binding ? settleDelivered(binding) : store.settleOpenRun(taskId, { ok: true });
      }
      else if (isPlainObject(result) && result.status !== "ok") {
        const binding = feed.store.read(taskId);
        binding ? fail(binding, "other") : store.settleOpenRun(taskId, { ok: false, code: "other" });
      }

      else store.settleOpenRun(taskId, { ok: true });
    },

    takeAgentRefresh(binding     ) {
      const taken = store.takeAgentRefresh(binding.taskId);
      if (!taken.ok) logger?.info?.(`[program-card] agent refresh capped task=${binding.taskId} cap=${taken.cap}`);
      return taken;
    },

    giveBackAgentRefresh(binding     , day        ) {
      return store.giveBackAgentRefresh(binding.taskId, day);
    },
    clear(taskId        ) {
      return store.clear(taskId);
    },
  };

  async function openedPart(clientId        , binding     ) {
    {
      const settings = store.read(binding.taskId);
      const allowed = gate(binding.taskId);
      if (!settings?.on || !allowed.ok) return frame(binding, "off", allowed.ok ? {} : { code: allowed.why });
      if (feed.bindingState(binding) !== "current") return frame(binding, "off", { code: "task_not_ready" });
      const nowMs = now();
      let row      = null;
      try { row = await rowRun(binding.taskId); } catch (_) { row = null; }
      const pending = store.pending(binding.taskId, nowMs);
      const deliveredAtMs = finiteMs(binding.last?.atMs);

      const dataAtMs = taskUncheckedDataAtMs(binding.last?.atMs, binding.last?.unchecked);

      const rowEndedAtMs = row && row.state !== "running" ? finiteMs(row.endedAtMs) : null;
      const rowSettled = !!pending && rowEndedAtMs !== null && rowEndedAtMs >= pending.atMs - 1000;
      const pendingGoing = pending && !(deliveredAtMs !== null && deliveredAtMs >= pending.atMs) && !rowSettled;
      if (pending && !pendingGoing) {
        if (deliveredAtMs !== null && deliveredAtMs >= pending.atMs) settleDelivered(binding);
        else if (row.state === "failed") store.settleOpenRun(binding.taskId, { ok: false, code: row.reason || "other", atMs: rowEndedAtMs });
        else store.settleOpenRun(binding.taskId, { ok: true });
      }

      const live = pending ? null : store.openRun(binding.taskId);
      if (live) {
        const endedAtMs = row && row.state !== "running" ? finiteMs(row.endedAtMs) : null;
        if ((deliveredAtMs !== null && deliveredAtMs >= live.atMs) || (endedAtMs !== null && endedAtMs >= live.atMs - 1000) ||
            (live.via === "feed" && activeTaskId() !== binding.taskId)) {
          store.settleOpenRun(binding.taskId, { ok: true });
        }
      }

      if (settings.failedCode === UNCHECKED_CODE && hasTaskUnchecked(binding.last?.unchecked) && Number.isFinite(settings.failedAtMs) &&
          nowMs - settings.failedAtMs < settings.staleMs && !pendingGoing) return frame(binding, "fresh");
      const running = activeTaskId() === binding.taskId || !!pendingGoing || row?.state === "running";
      const rowFailedAt = row?.state === "failed" ? finiteMs(row.endedAtMs) : null;
      const failedAtMs = Math.max(settings.failedAtMs ?? -1, rowFailedAt ?? -1);
      const decision      = decideTaskOpenUpdate({ settings, gate: allowed, dataAtMs, nowMs, running,
        failedAtMs: failedAtMs >= 0 ? failedAtMs : null });
      if (decision.state === "failed") {
        return frame(binding, "failed", { failedAtMs: decision.atMs,
          code: rowFailedAt === decision.atMs ? row.reason || "other" : settings.failedCode || "other" });
      }
      if (!decision.start) return frame(binding, decision.state);
      const started      = await start(binding, clientId);
      if (started.code) {
        fail(binding, started.code);
        return frame(binding, "failed", { failedAtMs: now(), code: started.code });
      }
      logger?.info?.(`[program-card] open-run started task=${binding.taskId} card=${binding.cardId} via=${started.via} ` +
        `ageMs=${dataAtMs === null ? "none" : nowMs - dataAtMs}${allowed.sim ? " gate=sim" : ""}`);
      return frame(binding, "updating", { via: started.via });
    }
  }
}

module.exports = { TASK_OPEN_UPDATE_DIR, TASK_OPEN_UPDATE_SIM_FILE, TASK_OPEN_UPDATE_STALE_CHOICES_MS, TASK_OPEN_UPDATE_DEFAULT_STALE_MS, TASK_AGENT_REFRESH_CAP_CHOICES, TASK_AGENT_REFRESH_DEFAULT_CAP, TASK_OPEN_UPDATE_WEEK_MS, TASK_OPEN_UPDATE_PENDING_MAX_MS, TASK_AGENT_REFRESH_CAP_REASON, TASK_OPEN_UPDATE_UNKNOWN_CHECK_MS, taskOpenUpdateDayKey, TASK_OPEN_UPDATE_SAVED_SHAPE, taskMayUpdateOnOpen, decideTaskOpenUpdate, createTaskOpenUpdateStore, createTaskOpenUpdate };
