const { deriveHermesPublicKey } = require("./hermes-session-keys.cjs");
const { TASK_USES_CHECK_FAILED_REASON, TASK_USES_NOT_ALLOWED, taskUsesCutArg } = require("../tools/glasses-ui-task-uses.cjs");

const LINK_TASK_USES_CHECK_METHOD = "task.uses.check";

const ARG_TEXT_MAX = 2000;

const ARGS_MAX = 32;
const ARG_DEPTH_MAX = 40;
const TOOL_NAME_MAX = 256;
const JOB_ID_MAX = 128;
const SESSION_KEY_MAX = 512;

const PROTO_KEY = "__proto__";

function isPlainObject(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function own(value     , key        ) {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function text(value     , limit = 512) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : "";
}

function whole(value     , limit        )                {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : null;
}

function refused() {
  return { block: true, reason: TASK_USES_CHECK_FAILED_REASON };
}

function holdsProtoKey(value     , depth        )          {
  if (value === null || typeof value !== "object") return false;
  if (depth > ARG_DEPTH_MAX) return true;
  if (Array.isArray(value)) return value.some((item) => holdsProtoKey(item, depth + 1));
  if (Object.prototype.hasOwnProperty.call(value, PROTO_KEY)) return true;
  return Object.keys(value).some((key) => holdsProtoKey(value[key], depth + 1));
}

function shortArgs(args     ) {
  if (args === undefined || args === null) return Object.create(null);
  if (!isPlainObject(args)) return null;
  const entries = Object.entries(args);
  if (entries.length > ARGS_MAX || holdsProtoKey(args, 0)) return null;
  const out = Object.create(null);
  for (const [key, value] of entries) {
    out[key] = typeof value === "string" ? taskUsesCutArg(value, ARG_TEXT_MAX) : value;
  }
  return out;
}

function curatedMcp(raw     ) {
  if (!isPlainObject(raw)) return null;
  const server = text(own(raw, "server"), 128);
  const tool = text(own(raw, "tool"), 128);
  if (!server || !tool) return null;
  const annotations      = {};
  const hints = isPlainObject(own(raw, "annotations")) ? raw.annotations : {};
  for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (typeof own(hints, hint) === "boolean") annotations[hint] = hints[hint];
  }
  return { server, tool, annotations, ownerWrite: own(raw, "ownerWrite") === true };
}

const OWNED_UNPLACED_REASON = `${TASK_USES_NOT_ALLOWED}: OcuClaw could not find this Task's run, so it skipped `
  + "this step. Carry on without it, and say in your answer what you could not do.";

const PLACEMENT_PROBE_TOOL = "cronjob";

function ownerOf(params     , cronJobId     ) {
  const raw = own(params, "ownerTaskId");
  const test = own(params, "ownerTest");
  if (raw === undefined && test === undefined) return undefined;
  const taskId = whole(raw, JOB_ID_MAX * 2);
  if (!taskId || !cronJobId || (test !== undefined && typeof test !== "boolean")) return null;
  return { taskId, test: test === true };
}

function namesTask(verdict     ) {
  return typeof verdict.taskId === "string" && verdict.taskId !== "";
}

function relayPlaces(relay     , input     ) {
  try {
    const probe = relay.checkTaskToolCall({ ...input, toolName: PLACEMENT_PROBE_TOOL, args: Object.create(null), mcp: null });
    return isPlainObject(probe) && probe.block === true && namesTask(probe);
  } catch (_) {
    return false;
  }
}

function answerHermesTaskUsesCheck(relay     , params     ) {
  if (!relay || typeof relay.checkTaskToolCall !== "function" || !isPlainObject(params)) return refused();
  const toolName = whole(own(params, "toolName"), TOOL_NAME_MAX);
  const cronJobId = whole(own(params, "cronJobId"), JOB_ID_MAX);
  const native = whole(own(params, "nativeSessionKey"), SESSION_KEY_MAX);
  if (!toolName || cronJobId === null || native === null) return refused();
  const sessionKey = native
    ? deriveHermesPublicKey({ sessionKey: native, source: text(own(params, "source"), 64) || null,
      id: text(own(params, "sessionId"), 128) || null })?.key || ""
    : "";
  if (!cronJobId && !sessionKey) return refused();
  const args = shortArgs(own(params, "args"));
  if (!args) return refused();
  const owner = ownerOf(params, cronJobId);
  if (owner === null) return refused();
  const input      = { toolName, args, sessionKey, cronJobId: cronJobId || null, mcp: curatedMcp(own(params, "mcp")) };
  if (owner) input.owner = owner;
  let verdict      = null;
  try {
    verdict = relay.checkTaskToolCall(input);
  } catch (_) {

    verdict = refused();
  }
  if (isPlainObject(verdict) && verdict.block === false) {

    if (owner && !namesTask(verdict) && !relayPlaces(relay, input)) {
      return { block: true, reason: OWNED_UNPLACED_REASON };
    }
    return { block: false };
  }
  if (isPlainObject(verdict) && verdict.block === true) {
    return { block: true, reason: String(verdict.reason || "not-allowed-for-this-task").slice(0, 1000) };
  }
  return refused();
}

module.exports = { LINK_TASK_USES_CHECK_METHOD, answerHermesTaskUsesCheck };
