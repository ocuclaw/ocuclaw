function sanitizeConnectReason(message) {
  return String(message ?? "")
    .replace(
      /(token|secret|nonce|sig|signature|authorization|password|auth)=([^\s&"']+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bbearer\s+\S+/gi, "bearer [REDACTED]")
    .replace(/[A-Za-z0-9_\-+/.=]{40,}/g, "[REDACTED]")
    .slice(0, 300);
}

module.exports = { sanitizeConnectReason };
