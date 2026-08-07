function readOpenClawHostVersion(env = process.env) {
  const raw = env ? env.OPENCLAW_SERVICE_VERSION || env.OPENCLAW_VERSION : undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

module.exports = { readOpenClawHostVersion };
