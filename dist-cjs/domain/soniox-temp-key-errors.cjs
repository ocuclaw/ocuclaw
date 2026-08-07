function normalizeSonioxTemporaryKeyErrorCodeForRelay(err) {
  const message =
    err && typeof err.message === "string" && err.message.trim()
      ? err.message.trim()
      : "";
  const lowered = message.toLowerCase();
  if (!message) return "soniox_temp_key_request_failed";

  if (err && err.name === "AbortError") {
    return "soniox_temp_key_mint_timeout";
  }
  if (lowered.includes("api key is not configured")) {
    return "soniox_temp_key_not_configured";
  }
  if (lowered.includes("fetch is not available")) {
    return "soniox_temp_key_fetch_unavailable";
  }
  if (lowered.includes("temporary-key response missing")) {
    return "soniox_temp_key_invalid_response";
  }
  if (lowered.includes("voicesessionid is required")) {
    return "soniox_temp_key_invalid_request";
  }
  const statusMatch = lowered.match(/\((\d{3})\)/);
  if (statusMatch) {
    return `soniox_temp_key_http_${statusMatch[1]}`;
  }
  return "soniox_temp_key_request_failed";
}

function normalizeSonioxTemporaryKeyErrorCodeForDownstream(err) {
  const message =
    err && typeof err.message === "string" && err.message.trim()
      ? err.message.trim()
      : "";
  const lowered = message.toLowerCase();
  if (!message) return "soniox_temp_key_request_failed";

  if (err && err.name === "AbortError") {
    return "soniox_temp_key_mint_timeout";
  }
  if (lowered.includes("is not available")) {
    return "soniox_temp_key_unavailable";
  }
  if (lowered.includes("voicesessionid is required")) {
    return "soniox_temp_key_invalid_request";
  }
  if (lowered.includes("api key is not configured")) {
    return "soniox_temp_key_not_configured";
  }

  if (lowered.includes("fetch is not available")) {
    return "soniox_temp_key_fetch_unavailable";
  }
  if (lowered.includes("missing temporarykey") || lowered.includes("missing expiresatms")) {
    return "soniox_temp_key_invalid_response";
  }
  const statusMatch = lowered.match(/\((\d{3})\)/);
  if (statusMatch) {
    return `soniox_temp_key_http_${statusMatch[1]}`;
  }
  return "soniox_temp_key_request_failed";
}

module.exports = { normalizeSonioxTemporaryKeyErrorCodeForRelay, normalizeSonioxTemporaryKeyErrorCodeForDownstream };
