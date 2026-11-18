function sanitizeAttemptSummary(raw     ) {
  if (!raw || raw.version !== 1) return { version: 0, completeness: "unsupported" };
  const out      = { version: 1 };
  const enums = {
    terminal: ["pending", "failure", "success", "cancellation", "supersession", "superseded", "wake_only", "ignored", "another_action"],
    inputSource: ["unknown", "ring", "temple", "phone", "automation", "simulator"],
    trigger: ["input", "automatic", "deferred", "unknown"],
    completeness: ["incomplete", "unknown"],
    credentialConfigured: ["unknown", "configured", "missing"], credentialActive: ["unknown", "active", "inactive"],
    selectedPath: ["soniox", "hermes", "cartesia", "augment"], effectivePath: ["soniox", "hermes", "cartesia", "augment"],
    backendKind: ["hermes", "openclaw", "unknown"], providerAvailability: ["available", "unavailable", "unknown"],
    configurationSource: ["app_settings_and_capabilities", "runtime"],
    captureCoverage: ["complete", "incomplete", "unknown"], noRequestEvidence: ["no_request_observed", "request_observed_not_admitted", "incomplete", "unknown", "not_applicable"],
    inputDisposition: ["wake_only", "voice_start", "another_action", "rejected", "ignored"],
  };
  for (const [key, values] of Object.entries(enums)) if (key in raw) out[key] = values.includes(raw[key]) ? raw[key] : "unknown";
  for (const key of ["attemptId", "voiceSessionId", "testId", "revision", "requestId", "warmRequestVoiceSessionId", "captureEpoch", "hermesProvider", "hermesModel"]) {
    if (typeof raw[key] === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(raw[key])) out[key] = raw[key];
  }
  const stages = new Set(["input_received", "input_disposed", "session_admitted", "session_linked", "wake_only", "input_rejected", "provider_selected", "configuration_rejected",
    "key_failed", "key_observed", "key_preparation_linked", "microphone_requested", "microphone_acknowledged", "first_audio_observed", "microphone_failed",
    "transcription_requested", "transcription_result", "transcription_failed", "send_requested", "send_acknowledged", "send_rejected",
    "cancelled", "superseded", "feedback_requested", "armed", "arm_rejected_busy", "request_accepted", "reply_marker_applied",
    "context_changed", "replied", "failed", "timed_out", "arm_requested", "arm_not_sent", "arm_accepted", "arm_rejected", "arm_unknown", "authenticated_request_received", "request_dispatched"]);
  for (const key of ["stage", "lastStage"]) if (stages.has(raw[key])) out[key] = raw[key];
  for (const key of ["startedAtMs", "clientTsMs", "configurationAtMs", "captureSeq", "armedAtMs", "deadlineMs", "observedAtMs", "authenticatedReceipts"]) {
    if (Number.isFinite(raw[key]) && raw[key] >= 0) out[key] = raw[key];
  }
  if (typeof raw.markerApplied === "boolean") out.markerApplied = raw.markerApplied;
  if (typeof raw.feedbackRequested === "boolean") out.feedbackRequested = raw.feedbackRequested;
  if (raw.feedbackRendered === "unknown") out.feedbackRendered = "unknown";
  if (typeof raw.feedbackCode === "string" && /^hermes_[a-z_]{1,48}$/.test(raw.feedbackCode)) out.feedbackCode = raw.feedbackCode;
  if (raw.stages && typeof raw.stages === "object") out.stages = Object.fromEntries(
    Object.entries(raw.stages).filter(([key, value]) => stages.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0));
  if (typeof raw.reasonCode === "string" && /^(?:ptt_active|streaming_active|capture_error|capture_start_failed|manual_finalize_unavailable|transcribing_timeout|not_connected|unavailable|busy|hermes_transcribe_failed|hermes_transcribe_timeout|hermes_stt_provider_not_picked|hermes_stt_relay_unavailable|soniox_temp_key_error_received|cartesia_access_token_error_applied|voice_attempt_(?:microphone_failed|send_rejected))$/.test(raw.reasonCode)) out.reasonCode = raw.reasonCode;
  return out;
}

function voiceDiagnosticPriority(event     ) {
  if (!["voice_attempt_summary", "even_ai_test_summary"].includes(event.event) || event.data?.version !== 1) return 0;
  return ["failure", "pending"].includes(event.data.terminal) ? 3 : 2;
}

module.exports = { sanitizeAttemptSummary, voiceDiagnosticPriority };
