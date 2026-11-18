const TASK_RUN_STATES = [

  "waiting",

  "running",

  "done",

  "nothing_new",

  "skipped",

  "missed",

  "failed",

  "not_synced",
];

const TASK_FAILURE_REASONS = [

  "sign_in_expired",

  "ai_busy",

  "timed_out",

  "result_lost",

  "setup_blocked",

  "host_stopped",

  "agent_gave_up",

  "host_refused",

  "other",
];

const TASK_SKIP_WHYS = [

  "overlap",

  "preflight",
  "other",
];

const TASK_LAST_RUN_OUTCOMES = ["ok", "quiet", "skipped", "failed"];

const TASK_SYNC_ERRORS = [

  "not_connected",

  "no_answer",

  "refused",

  "job_missing",
  "other",
];

const SYNC_ERROR_OF                         = {
  unsupported: "not_connected",
  management_unavailable: "not_connected",
  profile_not_served: "not_connected",
  invalid_scope: "not_connected",
  outcome_unknown: "no_answer",
  native_read_failed: "no_answer",
  response_identity_mismatch: "no_answer",
  schedule_invalid: "refused",
  page_watch_off: "refused",
  page_watch_once: "refused",
  job_paused: "refused",
  job_owned: "refused",
  job_no_prompt: "refused",
  starter_missing: "refused",
  starter_invalid: "refused",
  starter_changed: "refused",
  invalid_request: "refused",
  job_missing: "job_missing",
  job_not_owned: "job_missing",
};

function taskSyncError(code     )         {
  if (typeof code !== "string") return "other";
  const bare = code.startsWith("task_schedule_") ? code.slice("task_schedule_".length) : code;
  return Object.prototype.hasOwnProperty.call(SYNC_ERROR_OF, bare) ? SYNC_ERROR_OF[bare] : "other";
}

const TASK_SYNC_TRIES_MAX = 3;

const TASK_SYNC_RETRY_EVERY_MS = 15 * 60_000;
const TASK_RUN_NOTE_MAX = 80;
const TASK_RUN_DETAILS_MAX = 300;

const TASK_HOST_ERROR_MAX = 500;
const HOST_STATUS_MAX = 32;
const SYNC_CODE_MAX = 64;

const TASK_SAME_RUN_MS = 2 * 60_000;

const STATES = new Set(TASK_RUN_STATES);
const REASONS = new Set(TASK_FAILURE_REASONS);
const SKIP_WHYS = new Set(TASK_SKIP_WHYS);
const OUTCOMES = new Set(TASK_LAST_RUN_OUTCOMES);
const SYNC_ERRORS = new Set(TASK_SYNC_ERRORS);
const CONTROL = /[\u0000-\u001f\u007f]+/g;

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const stamp = (v     ) => Number.isSafeInteger(v) && v >= 0;
const stampOrNull = (v     ) => (stamp(v) ? v : null);

function clipPoints(text        , limit        )         {
  const points = Array.from(text);
  return points.length <= limit ? text : points.slice(0, limit - 1).join("").trimEnd() + "…";
}

function redactHostText(raw     )         {
  if (raw === null || raw === undefined) return "";
  let text = String(raw);

  text = text.replace(/\b(https?:\/\/[^\s?#"'`]+)[?#][^\s"'`]*/gi, "$1?[redacted]");
  text = text.replace(/(authorization\s*[:=]\s*)(?:bearer|basic|token)?\s*[^\s,"'`]+/gi, "$1[redacted]");
  text = text.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
  text = text.replace(
    /\b((?:[a-z]+[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|token|password|passwd|secret|cookie|session[_-]?id))(\s*["']?\s*[=:]\s*["']?)[^\s,;"'`&]+/gi,
    "$1$2[redacted]",
  );

  text = text.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{20,}|(?:sk|pk|rk)_(?:live_|test_)?[A-Za-z0-9]{16,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|tskey-[A-Za-z0-9-]{16,})\b/g,
    "[redacted]",
  );

  text = text.replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, "[redacted]");
  return text;
}

function hostLine(raw     , limit        )                {
  const text = redactHostText(raw).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return text ? clipPoints(text, limit) : null;
}

const SERVICES                          = [
  [/google[ _-]?calendar|gcal\b/i, "Google Calendar"],
  [/google[ _-]?drive|gdrive\b/i, "Google Drive"],
  [/google[ _-]?docs?\b/i, "Google Docs"],
  [/google[ _-]?sheets?\b/i, "Google Sheets"],
  [/gmail/i, "Gmail"],
  [/outlook|office[ _-]?365|microsoft[ _-]?graph/i, "Outlook"],
  [/github/i, "GitHub"],
  [/gitlab/i, "GitLab"],
  [/slack/i, "Slack"],
  [/notion/i, "Notion"],
  [/linear/i, "Linear"],
  [/jira|atlassian|confluence/i, "Atlassian"],
  [/todoist/i, "Todoist"],
  [/spotify/i, "Spotify"],
  [/dropbox/i, "Dropbox"],
  [/discord/i, "Discord"],
  [/telegram/i, "Telegram"],
  [/strava/i, "Strava"],
  [/home[ _-]?assistant/i, "Home Assistant"],
  [/openai|chatgpt|codex/i, "OpenAI"],
  [/anthropic|claude/i, "Anthropic"],
  [/openrouter/i, "OpenRouter"],
  [/gemini/i, "Gemini"],
  [/google/i, "Google"],
  [/microsoft|azure/i, "Microsoft"],
];

const TASK_SERVICE_NAMES                      = new Set(SERVICES.map(([, name]) => name));

function serviceOfError(text        )                {
  for (const [pattern, name] of SERVICES) if (pattern.test(text)) return name;
  return null;
}

const SIGN_IN = /\b401\b|invalid[_ ]grant|invalid[_ ]token|token[^.\n]{0,24}\b(?:expired|revoked|invalid)|expired[^.\n]{0,12}\b(?:token|credential|session|sign[- ]?in|login)|unauthori[sz]ed|unauthenticated|re-?authenticat|re-?authori[sz]|sign[- ]?in (?:again|required|expired)|log ?in (?:again|required|expired)|not (?:signed|logged) in|refresh token|oauth[^.\n]{0,24}(?:expired|failed|error)|credentials? (?:expired|revoked|missing)/i;
const TIMED_OUT = /timed? ?out|time-?out|deadline exceeded|took too long|inactivity|no progress for|exceeded[^.\n]{0,16}(?:time|limit of \d+ ?(?:s|sec|seconds|m|min|minutes)\b)/i;
const BUSY = /rate[ _-]?limit|\b429\b|\b529\b|\b503\b|\b502\b|overloaded|too many requests|over capacity|at capacity|service unavailable|temporarily unavailable|server (?:is )?busy|try again later|resource[_ ]exhausted|quota exceeded|insufficient[_ ]quota|provider (?:error|unavailable)|model (?:error|unavailable|overloaded)|upstream (?:error|unavailable)/i;
const DELIVERY = /deliver(?:y|ed)? (?:failed|error)|not[- ]delivered|could(?: not|n't) (?:be )?deliver|failed to deliver/i;
const CRON_FAILURE = /^\s*\[CRON_FAILURE\]\s*:?\s*/i;

const HOST_STOPPED = /\bjob interrupted by gateway restart\b|\bgateway (?:is )?(?:restarting|shutting down)\b|\bgateway shutdown\b/i;

const HOST_INTERRUPTED = /^\s*interrupted\.?\s*$/i;

function classifyTaskFailure(hostStatus     , error     )                                          {
  const status = typeof hostStatus === "string" ? hostStatus.trim().toLowerCase() : "";
  const text = typeof error === "string" ? error.slice(0, TASK_HOST_ERROR_MAX) : "";
  const firstLine = (value        ) => hostLine(value.split(/\r?\n/).find((l) => l.trim()) || "", TASK_RUN_NOTE_MAX);
  if (status === "blocked_config") {
    return { reason: "setup_blocked", note: firstLine(text.replace(/^\s*(?:blocked[_ ]config|setup (?:is )?blocked)\s*[:-]?\s*/i, "")) };
  }
  if (status === "interrupted") return { reason: "host_stopped", note: null };
  if (status === "delivery_failed" || status === "not-delivered" || status === "delivery_error") {
    return { reason: "result_lost", note: null };
  }
  if (status === "timeout" || status === "timed_out") return { reason: "timed_out", note: null };
  if (status === "host_refused") return { reason: "host_refused", note: firstLine(text) };
  if (status === "agent_failure" || CRON_FAILURE.test(text)) {
    return { reason: "agent_gave_up", note: firstLine(text.replace(CRON_FAILURE, "")) };
  }
  if (!text.trim()) return { reason: "other", note: null };
  if (HOST_STOPPED.test(text) || HOST_INTERRUPTED.test(text)) return { reason: "host_stopped", note: null };
  if (SIGN_IN.test(text)) return { reason: "sign_in_expired", note: serviceOfError(text) };
  if (TIMED_OUT.test(text)) return { reason: "timed_out", note: null };
  if (BUSY.test(text)) return { reason: "ai_busy", note: null };
  if (DELIVERY.test(text)) return { reason: "result_lost", note: null };
  return { reason: "other", note: null };
}

const TOOL_TRANSPORT = /\bE(?:CONNREFUSED|CONNRESET|CONNABORTED|NOTFOUND|AI_AGAIN|HOSTUNREACH|NETUNREACH|PIPE)\b|socket hang ?up|connection (?:closed|refused|reset|lost|error|failed)|(?:not|failed to|could(?: not|n't)) connect|disconnected|transport (?:closed|error|failed)|(?:server|process) (?:exited|crashed|closed|died|is not running|not running)|fetch failed|network (?:error|is unreachable)|no route to host|\bunavailable\b/i;

function classifyTaskToolError(error     )                                                                                              {
  const text = typeof error === "string" ? error.slice(0, TASK_HOST_ERROR_MAX) : "";
  const service = text ? serviceOfError(text) : null;
  if (TIMED_OUT.test(text)) return { code: "timed_out", service };
  if (TOOL_TRANSPORT.test(text)) return { code: "unavailable", service };
  if (SIGN_IN.test(text)) return { code: "sign_in_expired", service };
  if (BUSY.test(text)) return { code: "unavailable", service };
  return { code: "other", service };
}

const TASK_RUN_COSTS = Object.freeze(["actual", "estimated", "included", "unknown"]);

const TASK_RUN_PLANS = Object.freeze(["chatgpt"]);

const RUN_TOKENS_MAX = 1e12;

const RUN_USD_MAX = 1e6;

function curateRunUsage(raw     )      {
  if (!record(raw)) return null;
  const tokens = Number.isSafeInteger(raw.tokens) && raw.tokens >= 0 && raw.tokens <= RUN_TOKENS_MAX ? raw.tokens : null;
  if (tokens === null) return null;
  let cost = TASK_RUN_COSTS.includes(raw.cost) ? raw.cost : "unknown";
  const usd = typeof raw.usd === "number" && Number.isFinite(raw.usd) && raw.usd >= 0 && raw.usd <= RUN_USD_MAX ? raw.usd : null;
  const priced = cost === "actual" || cost === "estimated";
  if (priced && usd === null) cost = "unknown";
  const plan = cost === "included" && TASK_RUN_PLANS.includes(raw.plan) ? raw.plan : null;
  return { tokens, cost, usd: priced && usd !== null ? usd : null, ...(plan ? { plan } : {}) };
}

function curateToolSignIn(raw     )                                    {
  if (!record(raw)) return null;
  const service = typeof raw.service === "string" ? hostLine(raw.service, TASK_RUN_NOTE_MAX) : null;
  return { service };
}

function soleToolSignIn(failures     )                                    {
  if (!Array.isArray(failures) || failures.length !== 1 || !record(failures[0])) return null;
  const [only] = failures;
  return only.code === "sign_in_expired" ? { service: typeof only.service === "string" ? only.service : null } : null;
}

function taskRunHeld(failures     )          {
  if (!Array.isArray(failures) || !failures.length) return false;
  return failures.every((failure     ) => record(failure) && (failure.code === "not_allowed" || failure.code === "kept_off"));
}

function curateLastRun(raw     )      {
  if (!record(raw) || !OUTCOMES.has(raw.outcome) || !stamp(raw.endedAtMs)) return null;
  const startedAtMs = stampOrNull(raw.startedAtMs);
  if (startedAtMs !== null && startedAtMs > raw.endedAtMs) return null;
  const hostStatus = typeof raw.hostStatus === "string" && raw.hostStatus.trim() && raw.hostStatus.length <= HOST_STATUS_MAX &&
    !/[\u0000-\u001f\u007f]/.test(raw.hostStatus) ? raw.hostStatus.trim() : null;
  const error = typeof raw.error === "string" ? raw.error.slice(0, TASK_HOST_ERROR_MAX) : null;

  const usage = raw.outcome === "skipped" ? null : curateRunUsage(raw.usage);

  const signIn = raw.outcome === "failed" ? curateToolSignIn(raw.toolSignIn) : null;

  const held = raw.outcome === "failed" && raw.held === true;
  return {
    ...(usage ? { usage } : {}),
    ...(signIn ? { toolSignIn: signIn } : {}),
    ...(held ? { held: true } : {}),
    outcome: raw.outcome,
    startedAtMs,
    endedAtMs: raw.endedAtMs,
    hostStatus,
    error: error && error.trim() ? redactHostText(error) : null,
    retryAtMs: raw.outcome === "failed" ? stampOrNull(raw.retryAtMs) : null,
    skippedWhy: raw.outcome === "skipped" ? (SKIP_WHYS.has(raw.skippedWhy) ? raw.skippedWhy : "other") : null,
  };
}

function curateJobRun(raw     )      {
  if (!record(raw)) return null;
  const runningSinceMs = stampOrNull(raw.runningSinceMs);
  const lastRun = curateLastRun(raw.lastRun);
  return runningSinceMs === null && lastRun === null ? null : { runningSinceMs, lastRun };
}

function mergeJobRuns(a     , b     )      {
  if (!a) return b || null;
  if (!b) return a;
  const running = [a.runningSinceMs, b.runningSinceMs].filter(stamp);
  const lastRun = !a.lastRun ? b.lastRun : !b.lastRun ? a.lastRun : b.lastRun.endedAtMs > a.lastRun.endedAtMs ? b.lastRun : a.lastRun;
  return { runningSinceMs: running.length ? Math.max(...running) : null, lastRun: lastRun || null };
}

function curateSync(raw     )                                                                     {
  if (!record(raw)) return { tries: 0, code: null, nextTryAtMs: null };
  const tries = Number.isSafeInteger(raw.tries) && raw.tries > 0 ? Math.min(raw.tries, 1000) : 0;
  const code = typeof raw.code === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(raw.code) ? raw.code.slice(0, SYNC_CODE_MAX) : null;
  return { tries, code, nextTryAtMs: stampOrNull(raw.nextTryAtMs) };
}

function blank(state        )      {
  return {
    state, startedAtMs: null, endedAtMs: null, reason: null, note: null, details: null, retryAtMs: null,
    skippedWhy: null, syncTries: 0, syncError: null,
  };
}

function heldByOwner(last     , reason        )          {
  return last.outcome === "failed" && last.held === true && reason === "agent_gave_up";
}

function fromLastRun(last     , nowMs        )      {
  const base = { startedAtMs: last.startedAtMs, endedAtMs: last.endedAtMs };
  if (last.outcome === "ok") return { ...blank("done"), ...base };
  if (last.outcome === "quiet") return { ...blank("nothing_new"), ...base };
  if (last.outcome === "skipped") {
    return {
      ...blank("skipped"), ...base,

      startedAtMs: last.startedAtMs ?? last.endedAtMs,
      skippedWhy: last.skippedWhy || "other",
      note: last.skippedWhy === "overlap" ? null : hostLine(last.error, TASK_RUN_NOTE_MAX),
    };
  }
  let sorted = classifyTaskFailure(last.hostStatus, last.error);

  if (sorted.reason === "agent_gave_up" && last.toolSignIn) sorted = { reason: "sign_in_expired", note: last.toolSignIn.service };

  if (heldByOwner(last, sorted.reason)) return { ...blank("done"), ...base };
  return {
    ...blank("failed"), ...base,
    reason: sorted.reason,
    note: sorted.note,
    details: hostLine(last.error, TASK_RUN_DETAILS_MAX),
    retryAtMs: last.retryAtMs !== null && last.retryAtMs > nowMs ? last.retryAtMs : null,
  };
}

function taskRunFacts({
  scheduleState = null, sync = null, latestAtMs = null, failedAtMs = null, failedError = null, jobRun = null,
  missed = null, unchecked = null, nowMs,
}     )      {
  if (scheduleState === "unsynced") {
    const tries = curateSync(sync);
    const stopped = tries.tries >= TASK_SYNC_TRIES_MAX;
    return {
      ...blank("not_synced"),
      syncTries: Math.min(tries.tries, TASK_SYNC_TRIES_MAX),
      syncError: stopped ? (tries.code !== null && SYNC_ERRORS.has(tries.code) ? tries.code : "other") : null,
      retryAtMs: stopped ? null : tries.nextTryAtMs,
    };
  }

  if (scheduleState === "job_missing") {
    return { ...blank("not_synced"), syncTries: TASK_SYNC_TRIES_MAX, syncError: "job_missing" };
  }
  const last = jobRun && jobRun.lastRun ? jobRun.lastRun : null;
  let best      = null;
  if (stamp(latestAtMs)) best = { ...blank("done"), endedAtMs: latestAtMs };
  if (stamp(failedAtMs) && (!best || failedAtMs > best.endedAtMs)) {
    const sorted = classifyTaskFailure(null, failedError);
    best = {
      ...blank("failed"), endedAtMs: failedAtMs, reason: sorted.reason, note: sorted.note,
      details: hostLine(failedError, TASK_RUN_DETAILS_MAX),
    };
  }
  if (last) {
    const host = fromLastRun(last, nowMs);
    if (!best || last.endedAtMs > best.endedAtMs + TASK_SAME_RUN_MS) {

      best = host;
    } else if (Math.abs(last.endedAtMs - best.endedAtMs) <= TASK_SAME_RUN_MS && best.state === "failed" &&
      host.state === "done" && last.outcome === "failed") {

      best = { ...host, endedAtMs: best.endedAtMs };
    } else if (Math.abs(last.endedAtMs - best.endedAtMs) <= TASK_SAME_RUN_MS && host.state === best.state) {

      best = {
        ...host,
        endedAtMs: best.endedAtMs,
        startedAtMs: host.startedAtMs !== null && host.startedAtMs <= best.endedAtMs ? host.startedAtMs : null,
        details: host.details ?? best.details,
        note: host.note ?? best.note,
      };
    }
  }

  if (best && best.state === "done" && record(unchecked) && stamp(unchecked.atMs) &&
      Math.abs(unchecked.atMs - best.endedAtMs) <= TASK_SAME_RUN_MS) {
    best = {
      ...best,
      state: "failed",
      reason: REASONS.has(unchecked.reason) ? unchecked.reason : "other",
      note: typeof unchecked.note === "string" && unchecked.reason === "sign_in_expired" ? hostLine(unchecked.note, TASK_RUN_NOTE_MAX) : null,
      details: null,
      retryAtMs: null,
    };
  }
  const runningSinceMs = jobRun ? jobRun.runningSinceMs : null;

  if (stamp(runningSinceMs) && (!best || runningSinceMs > best.endedAtMs)) {
    return { ...blank("running"), startedAtMs: runningSinceMs };
  }
  const missedAt = missed && Number.isSafeInteger(missed.count) && missed.count > 0 ? stampOrNull(missed.lastAtMs) : null;

  if (missedAt !== null && !(best && best.state === "failed" && best.endedAtMs > missedAt)) {
    return { ...blank("missed"), startedAtMs: missedAt };
  }
  return best || blank("waiting");
}

function newestRunAtMs(latestAtMs     , failedAtMs     , jobRun     )                {
  const times = [latestAtMs, failedAtMs, jobRun && jobRun.lastRun ? jobRun.lastRun.endedAtMs : null].filter(stamp);
  return times.length ? Math.max(...times) : null;
}

function taskRunWire(run     )      {
  if (!record(run) || !STATES.has(run.state)) return null;
  const keys = ["state", "startedAtMs", "endedAtMs", "reason", "note", "details", "retryAtMs", "skippedWhy", "syncTries",
    "syncError"];
  if (Object.keys(run).length !== keys.length || !keys.every((key) => Object.hasOwn(run, key))) return null;
  for (const key of ["startedAtMs", "endedAtMs", "retryAtMs"]) if (run[key] !== null && !stamp(run[key])) return null;
  if (run.reason !== null && (run.state !== "failed" || !REASONS.has(run.reason))) return null;
  if (run.state === "failed" && run.reason === null) return null;
  if (run.skippedWhy !== null && (run.state !== "skipped" || !SKIP_WHYS.has(run.skippedWhy))) return null;
  if (run.note !== null && (typeof run.note !== "string" || Array.from(run.note).length > TASK_RUN_NOTE_MAX)) return null;
  if (run.details !== null && (typeof run.details !== "string" || Array.from(run.details).length > TASK_RUN_DETAILS_MAX)) return null;
  if (!Number.isSafeInteger(run.syncTries) || run.syncTries < 0) return null;
  if (run.syncError !== null && typeof run.syncError !== "string") return null;
  return run;
}

module.exports = { TASK_RUN_STATES, TASK_FAILURE_REASONS, TASK_SKIP_WHYS, TASK_LAST_RUN_OUTCOMES, TASK_SYNC_ERRORS, taskSyncError, TASK_SYNC_TRIES_MAX, TASK_SYNC_RETRY_EVERY_MS, TASK_RUN_NOTE_MAX, TASK_RUN_DETAILS_MAX, TASK_HOST_ERROR_MAX, TASK_SAME_RUN_MS, redactHostText, hostLine, TASK_SERVICE_NAMES, serviceOfError, classifyTaskFailure, classifyTaskToolError, TASK_RUN_COSTS, TASK_RUN_PLANS, curateRunUsage, soleToolSignIn, taskRunHeld, curateLastRun, curateJobRun, mergeJobRuns, curateSync, taskRunFacts, newestRunAtMs, taskRunWire };
