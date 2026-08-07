const STREAM = new Set([
  "text_delta", "status", "tool_start", "tool_end",
  "running_stats", "user_prompt", "task_progress",
]);
const DEMAND = new Set([
  "permission_request", "user_question",
  "permission_result", "question_answer",
]);
const NOTIFY = new Set(["notification", "error"]);

function classifyFrame(frame, opts = {}) {
  const active = opts.active !== false;
  const type = frame && typeof frame.type === "string" ? frame.type : "";
  if (type === "result") {
    return { class: active ? "stream" : "notify", type };
  }
  if (DEMAND.has(type)) return { class: "demand", type };
  if (STREAM.has(type)) return { class: "stream", type };
  if (NOTIFY.has(type)) return { class: "notify", type };
  return { class: "notify", type };
}

module.exports = { classifyFrame };
