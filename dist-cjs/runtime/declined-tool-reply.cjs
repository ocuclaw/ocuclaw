const DECLINED_TOOL_FALLBACK_REPLY =
  "I couldn't finish that. A command I needed wasn't approved, so I stopped.";

const DECLINED_TOOL_STATUSES = new Set(["blocked", "declined", "denied"]);

const GLASSES_UI_TOOLS = new Set(["compose_glasses_ui", "render_glasses_ui"]);
const MAX_TRACKED_RUNS = 64;

function isDeclinedToolEnd(toolEnd     ) {
  if (!toolEnd || toolEnd.isError !== true) return false;
  const status = typeof toolEnd.status === "string" ? toolEnd.status.trim().toLowerCase() : "";
  return DECLINED_TOOL_STATUSES.has(status);
}

function createDeclinedToolRunTracker() {
  const runs = new Map();

  function remember(runId     , entry     ) {
    runs.delete(runId);
    runs.set(runId, entry);
    while (runs.size > MAX_TRACKED_RUNS) runs.delete(runs.keys().next().value);
  }

  function noteToolEnd(runId     , toolEnd     ) {
    if (typeof runId !== "string" || !runId || !toolEnd) return;
    const entry = runs.get(runId);
    if (isDeclinedToolEnd(toolEnd)) {
      remember(runId, { declined: true, answeredOnGlasses: entry ? entry.answeredOnGlasses : false });
      return;
    }

    if (GLASSES_UI_TOOLS.has(toolEnd.tool) && toolEnd.isError !== true) {
      remember(runId, { declined: entry ? entry.declined : false, answeredOnGlasses: true });
    }
  }

  function takeFallback(runId     , replyText     ) {
    if (typeof runId !== "string" || !runId || !runs.has(runId)) return null;
    const entry = runs.get(runId);
    runs.delete(runId);
    if (!entry.declined || entry.answeredOnGlasses) return null;
    if (typeof replyText === "string" && replyText.trim()) return null;
    return DECLINED_TOOL_FALLBACK_REPLY;
  }

  function clear() {
    runs.clear();
  }

  return { noteToolEnd, takeFallback, clear };
}

module.exports = { DECLINED_TOOL_FALLBACK_REPLY, isDeclinedToolEnd, createDeclinedToolRunTracker };
