const { COMPOSE_GLASSES_UI_TOOL_NAME } = require("../tools/glasses-ui-compose-tool.cjs");
const { LIVEUI_TASK_TOOL_NAME } = require("../tools/glasses-ui-task-library.cjs");
const { LIVEUI_TEMPLATE_TOOL_NAME } = require("../tools/glasses-ui-template-library.cjs");
const { SAVE_GLASSES_CARD_TOOL_NAME } = require("../tools/save-glasses-card-tool.cjs");
const { ASK_CARD_TOOL_NAME } = require("../domain/glasses-ui-jev-card.cjs");

const AUTOMATION_REFUSED_TOOLS = new Set([
  COMPOSE_GLASSES_UI_TOOL_NAME,
  "get_glasses_ui_state",
  LIVEUI_TEMPLATE_TOOL_NAME,
  LIVEUI_TASK_TOOL_NAME,
  SAVE_GLASSES_CARD_TOOL_NAME,
  ASK_CARD_TOOL_NAME,

  "write_glasses_card",
  "glasses_card_command",
  "edit_glasses_card",
  "look_glasses_card",
  "glasses_card_draft",

  "request_card_mcp_write",

  "request_host_command",

  "request_card_setup",
]);

const AUTOMATION_RUN_REFUSAL =
  "glasses-refused-in-scheduled-run: this turn is a scheduled run with nobody watching the glasses. " +
  "Do not draw. Answer in plain text; OcuClaw shows your answer on the glasses later.";

const CRON_JOB_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function cronJobOfSessionKey(sessionKey     )                {
  if (typeof sessionKey !== "string") return null;
  let rest = sessionKey.trim();
  const scoped = /^agent:[^:]+:(.+)$/i.exec(rest);
  if (scoped) rest = scoped[1];
  const match = /^cron:([^:]+)(?::|$)/i.exec(rest);
  return match && CRON_JOB_ID_RE.test(match[1]) ? match[1] : null;
}

function createAutomationRunGuardHook(opts      = {}) {
  const enabled = typeof opts.enabled === "function" ? opts.enabled : () => false;
  const onRefused = typeof opts.onRefused === "function" ? opts.onRefused : null;
  return async function refuseGlassesInAutomationRun(event     , ctx      = null) {
    const toolName = typeof event?.toolName === "string" ? event.toolName : "";
    if (!AUTOMATION_REFUSED_TOOLS.has(toolName)) return undefined;
    const jobId = cronJobOfSessionKey(ctx?.sessionKey);
    if (!jobId) return undefined;
    let on = false;
    try {
      on = enabled() === true;
    } catch (_) {
      on = false;
    }
    if (!on) return undefined;
    if (onRefused) {
      try {
        onRefused({ toolName, jobId });
      } catch (_) {

      }
    }
    return { block: true, blockReason: AUTOMATION_RUN_REFUSAL };
  };
}

module.exports = { AUTOMATION_REFUSED_TOOLS, AUTOMATION_RUN_REFUSAL, cronJobOfSessionKey, createAutomationRunGuardHook };
