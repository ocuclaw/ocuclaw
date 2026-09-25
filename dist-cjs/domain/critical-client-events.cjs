const PHONE_CRITICAL_EVENT_NAMES = Object.freeze([
  "screen_navigation_requested",
  "rebuild_error",
  "screen_enter_skipped_stale",
  "screen_enter_rollback",
  "screen_enter_rollback_failed",
  "owned_job_uncaught",
  "latched_screen_watchdog",
  "liveui_render_failed",
  "liveui_render_unparsed",
  "global_error_hook",
  "boot_viewport_snapshot",
  "boot_frame_pump_snapshot",
  "boot_clock_ledger",
  "timer_scheduler_driver_recreated",
  "post_canvas_watchdog_late",
  "heartbeat_degraded_suppression",
  "display_fence_timeout",
  "relay_auto_restore_gate",
  "getting_started_returning_handoff",
  "startup_default_session_requested",
  "message_screen_reentry_requested",
]);

const FORCED_CLIENT_EVENT_NAMES = Object.freeze([
  ...PHONE_CRITICAL_EVENT_NAMES,
  "readiness_probe_received",
  "boot_trace",
]);

const forcedNames = new Set(FORCED_CLIENT_EVENT_NAMES);

function isForcedClientEvent(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (forcedNames.has(payload.event)) return true;
  return !!(
    payload.event === "relay_socket_lifecycle" &&
    payload.data &&
    payload.data.lifecycleEvent === "close"
  );
}

module.exports = { PHONE_CRITICAL_EVENT_NAMES, FORCED_CLIENT_EVENT_NAMES, isForcedClientEvent };
