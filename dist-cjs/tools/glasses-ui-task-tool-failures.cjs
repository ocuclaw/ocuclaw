const { classifyTaskToolError, serviceOfError } = require("../domain/task-run-facts.cjs");

const CODES = new Set        (["not_allowed", "kept_off", "sign_in_expired", "timed_out", "unavailable", "other"]);

const TASK_TOOL_GROUPS_MAX = 32;
const TASK_TOOL_RUNS_MAX = 64;

const TASK_TOOL_RUN_TTL_MS = 6 * 60 * 60 * 1000;
const GROUP_MAX = 96;

const record = (v     )                           => !!v && typeof v === "object" && !Array.isArray(v);
const stamp = (v     )                => (Number.isSafeInteger(v) && v >= 0 ? v : null);

function taskToolGroupOfMcp(server         )                {
  return typeof server === "string" && server.trim() ? `mcp:${server.trim()}`.slice(0, GROUP_MAX) : null;
}

function taskToolGroupService(group        )                {
  return serviceOfError(group.replace(/^(?:mcp|tool):/, ""));
}

const ERROR_TEXT_MAX = 2000;

function resultText(content         , depth = 0)         {
  if (depth > 8) return "";
  if (typeof content === "string") {
    const trimmed = content.trim();

    if (trimmed.startsWith("{") && trimmed.length <= ERROR_TEXT_MAX * 4) {
      try {
        const parsed = JSON.parse(trimmed);
        if (record(parsed) && Array.isArray(parsed.content)) return resultText(parsed.content, depth + 1);
      } catch (_) {  }
    }
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => resultText(part, depth + 1)).filter(Boolean).join("\n").slice(0, ERROR_TEXT_MAX);
  }
  if (!record(content)) return "";
  if (typeof content.text === "string") return resultText(content.text, depth + 1);
  if (content.content !== undefined) return resultText(content.content, depth + 1);
  return "";
}

function taskToolResultError(message     )                            {
  if (!record(message) || message.role !== "toolResult") return undefined;
  if (message.isError !== true) return null;
  return resultText(message.content).trim().slice(0, ERROR_TEXT_MAX) || "error";
}

function taskToolMcpServerOf(toolName         , servers          )                {
  if (typeof toolName !== "string" || !toolName) return null;
  const match = servers.filter((name) => typeof name === "string" && name &&
    (toolName.startsWith(`${name}__`) || toolName.startsWith(`${name}.`)) && toolName.length > name.length + 2)
    .sort((a, b) => b.length - a.length)[0];
  return match || null;
}

function validTaskToolFailure(raw         )                         {
  if (!record(raw) || typeof raw.group !== "string" || !raw.group || raw.group.length > GROUP_MAX) return null;
  if (!CODES.has(raw.code)) return null;
  const at = stamp(raw.at);
  if (at === null) return null;
  const service = typeof raw.service === "string" && raw.service && serviceOfError(raw.service) === raw.service ? raw.service : null;
  return { group: raw.group, code: raw.code, service, at };
}

function validTaskToolFailures(raw         )                           {
  if (!Array.isArray(raw)) return null;
  const out = raw.slice(0, TASK_TOOL_GROUPS_MAX).map(validTaskToolFailure).filter(Boolean)                     ;
  return out.length ? out : null;
}

function taskToolReasons(values         , failures         , unfit           = [])                                                                              {
  const failed = validTaskToolFailures(failures);
  if (!record(values) || !failed || failed.length !== 1) return null;
  const skip = new Set(unfit);
  const nulls = Object.keys(values).filter((key) => values[key] === null && !skip.has(key));
  if (nulls.length !== 1) return null;
  const [only] = failed;
  return { [nulls[0]]: { why: only.code, service: only.service } };
}

function createTaskToolLedger(opts                                                           = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const runsMax = Number.isSafeInteger(opts.runsMax) && (opts.runsMax          ) > 0 ? opts.runsMax           : TASK_TOOL_RUNS_MAX;
  const ttlMs = Number.isSafeInteger(opts.ttlMs) && (opts.ttlMs          ) > 0 ? opts.ttlMs           : TASK_TOOL_RUN_TTL_MS;

  const runs = new Map                                                                ();

  function prune() {
    const oldest = now() - ttlMs;
    for (const [key, run] of runs) if (run.at < oldest) runs.delete(key);
    while (runs.size > runsMax) runs.delete(runs.keys().next().value          );
  }

  function touch(run        ) {
    if (typeof run !== "string" || !run) return null;
    const at = now();
    let held = runs.get(run);
    if (held) runs.delete(run);
    else held = { at, groups: new Map(), ran: false };
    held.at = at;
    runs.set(run, held);
    return held;
  }

  function note(run        , group        , entry                                                                      ) {
    if (typeof group !== "string" || !group) return;
    const held = touch(run);
    if (!held) return;
    const at = held.at;
    if (entry.ok) held.ran = true;
    held.groups.delete(group);
    held.groups.set(group.slice(0, GROUP_MAX), { ok: entry.ok, code: entry.code || "other", service: entry.service ?? null, at });
    while (held.groups.size > TASK_TOOL_GROUPS_MAX) held.groups.delete(held.groups.keys().next().value          );
    prune();
  }

  return {

    noteCall(run        , group               , error               ) {
      if (!group) return;
      if (error === null) return note(run, group, { ok: true });
      const sorted = classifyTaskToolError(error);
      note(run, group, { ok: false, code: sorted.code, service: sorted.service || taskToolGroupService(group) });
    },

    noteRefused(run        , group               , code                            ) {
      if (!group) return;
      note(run, group, { ok: false, code, service: taskToolGroupService(group) });
    },

    noteRan(run        ) {
      const held = touch(run);
      if (!held) return;
      held.ran = true;
      prune();
    },

    ran(run        )                 {
      prune();
      const held = typeof run === "string" ? runs.get(run) : null;
      return held ? held.ran : null;
    },
    failures(run        , sinceMs                = null)                    {
      prune();
      const held = typeof run === "string" ? runs.get(run) : null;
      if (!held) return [];
      const since = stamp(sinceMs);
      const out                    = [];
      for (const [group, entry] of held.groups) {
        if (entry.ok || (since !== null && entry.at < since)) continue;
        out.push({ group, code: entry.code, service: entry.service, at: entry.at });
      }
      return out;
    },
    drop(run        ) {
      runs.delete(run);
    },
    size() {
      return runs.size;
    },
  };
}

module.exports = { TASK_TOOL_GROUPS_MAX, TASK_TOOL_RUNS_MAX, TASK_TOOL_RUN_TTL_MS, taskToolGroupOfMcp, taskToolGroupService, taskToolResultError, taskToolMcpServerOf, validTaskToolFailure, validTaskToolFailures, taskToolReasons, createTaskToolLedger };
