const UPLOAD_CAPTURE_PRESET = [
  "sdk.frames", "render.header_animation", "render.virtual_pager.diagnostics", "render.ownership",
  "screen.nav", "app.lifecycle", "session.timeline", "voice.timeline", "voice.transport",
  "relay.session", "relay.protocol", "relay.health", "relay.worker.health", "relay.operation", "relay.transport",
  "glasses.lifecycle", "openclaw.run", "openclaw.message", "hermes.link", "evenai",
];

const UPLOAD_EVENT_EXCLUDES = Object.freeze({
  "app.lifecycle": Object.freeze([
    "automation_state_request_received",
    "automation_state_response_built",
    "readiness_probe_received",
  ]),
});

function filterUploadEvents(events) {
  if (!Array.isArray(events)) return events;
  return events.filter((evt) => {
    const excluded = evt && typeof evt.cat === "string" ? UPLOAD_EVENT_EXCLUDES[evt.cat] : undefined;
    return !excluded || typeof evt.event !== "string" || !excluded.includes(evt.event);
  });
}

function startUploadCaptureArming(deps) {
  if (!deps.gatesOn()) return () => {};

  const preset =
    deps.preset && Array.isArray(deps.preset) && deps.preset.length ? deps.preset : UPLOAD_CAPTURE_PRESET;

  const armSafely = () => {
    try {
      deps.armCategories(preset, deps.maxTtlMs);
    } catch (err) {
      if (deps.onArmError) deps.onArmError(err);
    }
  };
  armSafely();
  const handle = deps.setInterval(() => {
    if (deps.gatesOn()) armSafely();
  }, Math.round(0.8 * deps.maxTtlMs));
  handle.unref();
  return () => deps.clearInterval(handle);
}

module.exports = { UPLOAD_CAPTURE_PRESET, UPLOAD_EVENT_EXCLUDES, filterUploadEvents, startUploadCaptureArming };
