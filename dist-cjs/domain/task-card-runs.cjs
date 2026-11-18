const { curateLastRun } = require("./task-run-facts.cjs");

const TASK_CARD_RUNS_MAX = 200;

const TASK_CARD_JOB_RUN_MAX_MS = 10 * 60_000;

const stamp = (value     ) => Number.isSafeInteger(value) && value > 0;

function taskCardLastRun(run     )      {
  if (!run || typeof run !== "object" || !stamp(run.endedAt)) return null;
  const startedAtMs = stamp(run.startedAt) ? run.startedAt : null;
  const failed = (hostStatus        ) => curateLastRun({ outcome: "failed", startedAtMs, endedAtMs: run.endedAt, hostStatus });
  switch (run.endedReason) {
    case "fed":
      return curateLastRun({ outcome: "ok", startedAtMs, endedAtMs: run.endedAt });

    case "no_ui":
      return failed("agent_failure");
    case "launch_failed":
    case "render_failed":
      return failed(run.endedReason);

    case "host_lost":
    case "glasses_disconnected":
    case "session_reset":
      return failed("interrupted");
    default:
      return null;
  }
}

function createTaskCardRuns(opts      = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const byTask = new Map                                                                                                           ();

  function entry(taskId        ) {
    const kept = byTask.get(taskId) || { runId: null, runningSinceMs: null, lastRun: null, jobSinceMs: null };
    byTask.delete(taskId);
    byTask.set(taskId, kept);
    while (byTask.size > TASK_CARD_RUNS_MAX) byTask.delete(byTask.keys().next().value          );
    return kept;
  }

  function feedRun(run     )          {
    return !!run && typeof run === "object" && !!run.feed && typeof run.taskId === "string" && !!run.taskId;
  }

  return {
    started(run     )          {
      if (!feedRun(run) || !stamp(run.startedAt)) return false;
      const kept = entry(run.taskId);
      kept.runId = typeof run.runId === "string" ? run.runId : null;
      kept.runningSinceMs = run.startedAt;
      return true;
    },
    ended(run     )          {
      if (!feedRun(run)) return false;
      const kept = entry(run.taskId);
      const wasRunning = kept.runningSinceMs !== null;
      if (kept.runId === null || kept.runId === run.runId) {
        kept.runId = null;
        kept.runningSinceMs = null;
      }
      const last = taskCardLastRun(run);
      if (last && (!kept.lastRun || last.endedAtMs >= kept.lastRun.endedAtMs)) kept.lastRun = last;
      if (!kept.runningSinceMs && !kept.lastRun && !kept.jobSinceMs) byTask.delete(run.taskId);
      return wasRunning || !!last;
    },

    jobStarted(taskId        , atMs         = now())          {
      if (typeof taskId !== "string" || !taskId || !stamp(atMs)) return false;
      entry(taskId).jobSinceMs = atMs;
      return true;
    },

    jobNotStarted(taskId        , atMs        )          {
      const kept = byTask.get(taskId);
      if (!kept || kept.jobSinceMs !== atMs) return false;
      kept.jobSinceMs = null;
      if (!kept.runningSinceMs && !kept.lastRun) byTask.delete(taskId);
      return true;
    },

    snapshot()                                                                  {
      const out                                                                  = {};
      const nowMs = now();
      for (const [taskId, kept] of byTask) {
        const job = stamp(kept.jobSinceMs) && nowMs - (kept.jobSinceMs          ) < TASK_CARD_JOB_RUN_MAX_MS ? kept.jobSinceMs           : null;
        const running = [kept.runningSinceMs, job].filter(stamp)            ;
        out[taskId] = { runningSinceMs: running.length ? Math.max(...running) : null, lastRun: kept.lastRun ? { ...kept.lastRun } : null };
      }
      return out;
    },
  };
}

module.exports = { TASK_CARD_RUNS_MAX, TASK_CARD_JOB_RUN_MAX_MS, taskCardLastRun, createTaskCardRuns };
