const UPLOAD_CAPTURE_PRESET = [
  "sdk.frames", "render.header_animation", "render.virtual_pager.diagnostics", "render.ownership",
  "screen.nav", "app.lifecycle", "session.timeline", "voice.timeline", "voice.transport",
  "relay.session", "relay.protocol", "relay.health", "relay.worker.health", "relay.operation", "relay.transport",
  "glasses.lifecycle", "openclaw.run", "openclaw.message", "hermes.link", "evenai", "liveui.library.events",
];

const UPLOAD_CAPTURE_PRESET_RELAY_ONLY = [
  "relay.protocol", "relay.health", "relay.worker.health", "relay.operation", "relay.transport",
  "glasses.lifecycle", "openclaw.run", "openclaw.message", "hermes.link", "evenai",
];

const DEBUG_FOLD_CAPABLE_CLIENT_VERSION = "2.0.4";

function parseReleaseVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim());
  if (!match) return null;
  const parts = match.slice(1, 4).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { parts, prerelease: match[4] || null };
}

function isFoldCapableClientVersion(value, floor = DEBUG_FOLD_CAPABLE_CLIENT_VERSION) {
  const actual = parseReleaseVersion(value);
  const required = parseReleaseVersion(floor);
  if (!actual || !required) return false;
  for (let index = 0; index < actual.parts.length; index += 1) {
    if (actual.parts[index] !== required.parts[index]) {
      return actual.parts[index] > required.parts[index];
    }
  }
  if (actual.prerelease && !required.prerelease) return false;
  return true;
}

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

  const fullPreset =
    deps.preset && Array.isArray(deps.preset) && deps.preset.length ? deps.preset : UPLOAD_CAPTURE_PRESET;

  const armSafely = () => {
    try {
      const versions = deps.getConnectedClientVersions ? deps.getConnectedClientVersions() : [];
      const compatibilityArm = Array.isArray(versions) && versions.some(
        (version) => !isFoldCapableClientVersion(version),
      );
      const armFullPreset = !deps.fullPresetOn || deps.fullPresetOn() || compatibilityArm;
      const preset = armFullPreset ? fullPreset : UPLOAD_CAPTURE_PRESET_RELAY_ONLY;

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
  const dispose = () => deps.clearInterval(handle);

  dispose.refresh = () => {
    if (deps.gatesOn()) armSafely();
  };
  return dispose;
}

module.exports = { UPLOAD_CAPTURE_PRESET, UPLOAD_CAPTURE_PRESET_RELAY_ONLY, DEBUG_FOLD_CAPABLE_CLIENT_VERSION, isFoldCapableClientVersion, UPLOAD_EVENT_EXCLUDES, filterUploadEvents, startUploadCaptureArming };
