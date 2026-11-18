function cleanVersion(raw     ) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function readOpenClawHostVersion(env = process.env, runtimeVersion      = undefined) {
  const fromEnv = cleanVersion(env ? env.OPENCLAW_SERVICE_VERSION || env.OPENCLAW_VERSION : undefined);
  if (fromEnv) return fromEnv;
  let fallback = runtimeVersion;
  if (typeof fallback === "function") {
    try { fallback = fallback(); } catch { fallback = undefined; }
  }
  return cleanVersion(fallback);
}

module.exports = { readOpenClawHostVersion };
