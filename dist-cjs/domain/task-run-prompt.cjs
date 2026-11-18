const { TASK_ALERT_STATE_PROMPT } = require("./task-alert-state.cjs");

const LINK_TASK_RUN_PROMPT_METHOD = "task.run.prompt";

const TASK_RUN_FAILURE_MARKER = "[CRON_FAILURE]";

const TASK_RUN_REFUSED_MARKER = "[HOST_REFUSED]";

const TASK_RUN_FAILURE_PROMPT =
  "OcuClaw run rule: if a tool, sign-in or service this run needs failed and nothing else could " +
  "stand in for it, so you could check nothing the request asks for, reply with " +
  `${TASK_RUN_FAILURE_MARKER} alone on the first line, then one short plain line, in the user's ` +
  "language, saying what you could not check (for example: Couldn't read the status: the status " +
  `service refused.). ${TASK_RUN_FAILURE_MARKER} is a literal ASCII control token: never translate ` +
  "it and never put other words on its line. If you could check part of the request, do not use " +
  "it: answer normally and say what you could not check.";

const TASK_RUN_REFUSED_PROMPT =
  "OcuClaw run rule: if this host itself refused to run a command or action the request needs " +
  "(for example its execution policy or sandbox rejected it), so that part was not done, reply with " +
  `${TASK_RUN_REFUSED_MARKER} alone on the first line, then one short plain line, in the user's ` +
  "language, naming what it would not run (for example: It wouldn't let me delete the old log files.). " +
  `${TASK_RUN_REFUSED_MARKER} is a literal ASCII control token: never translate it and never put ` +
  `other words on its line. It takes the place of ${TASK_RUN_FAILURE_MARKER}. Do not use it when a ` +
  "command ran and failed, nor when OcuClaw held a step for the owner's OK.";

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);

function taskOfJob(jobId        , schedules     )      {
  if (!Array.isArray(schedules)) return null;
  return schedules.find((row     ) => record(row) && row.jobId === jobId && typeof row.taskId === "string") || null;
}

function isTextBrief(task     , cardBound                             )          {
  if (!record(task) || task.kind !== "brief") return false;
  if (typeof task.lookTemplateId === "string" && task.lookTemplateId) return false;
  try {
    return cardBound(task.taskId) !== true;
  } catch (_) {

    return false;
  }
}

function taskRunPromptBlocks(jobId     , { schedules = [], cardBound = () => false, host = null }      = {})           {
  return taskRunPromptNamed(jobId, { schedules, cardBound, host }).map((block) => block.text);
}

function taskRunPromptNamed(jobId     , { schedules = [], cardBound = () => false, host = null }      = {})                                        {
  if (typeof jobId !== "string" || !jobId) return [];
  const task = taskOfJob(jobId, schedules);
  if (!task) return [];
  const blocks                                        = [];
  const textBrief = isTextBrief(task, typeof cardBound === "function" ? cardBound : () => false);
  if (textBrief) blocks.push({ name: "failure_marker", text: TASK_RUN_FAILURE_PROMPT });

  if (textBrief && host === "openclaw") blocks.push({ name: "refused_marker", text: TASK_RUN_REFUSED_PROMPT });
  if (task.kind === "alert") blocks.push({ name: "alert_state", text: TASK_ALERT_STATE_PROMPT });
  return blocks;
}

function taskRunPromptContext(jobId     , deps      = {})                {
  const blocks = taskRunPromptBlocks(jobId, deps);
  return blocks.length ? blocks.join("\n\n") : null;
}

function agentDeclaredFailure(text     )                {
  if (typeof text !== "string") return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.length || lines[0].trimEnd() !== TASK_RUN_FAILURE_MARKER) return null;
  return lines.slice(1).join("\n").trim() || "Cron agent reported failure.";
}

function hostRefusedRun(text     )                {
  if (typeof text !== "string") return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.length || lines[0].trimEnd() !== TASK_RUN_REFUSED_MARKER) return null;
  return lines.slice(1).join("\n").trim() || "The host refused to run it.";
}

module.exports = { LINK_TASK_RUN_PROMPT_METHOD, TASK_RUN_FAILURE_MARKER, TASK_RUN_REFUSED_MARKER, TASK_RUN_FAILURE_PROMPT, TASK_RUN_REFUSED_PROMPT, isTextBrief, taskRunPromptBlocks, taskRunPromptNamed, taskRunPromptContext, agentDeclaredFailure, hostRefusedRun };
