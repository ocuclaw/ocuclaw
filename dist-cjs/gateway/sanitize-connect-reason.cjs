const MAX_INPUT_CHARS = 2000;
const MAX_REASON_CHARS = 300;

const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi;

const AUTH_SCHEME_RE = /\b(bearer|basic|digest)\s+[^\s"',;}]+/gi;

const CREDENTIAL_KEY_RE =
  /([A-Za-z0-9_.-]*(?:token|secret|nonce|sig|signature|authorization|password|passwd|pwd|auth|key|credentials?|cookie|(?:pairing|setup)[_-]?code)s?(?:\\*["'])?\s*(?:[:=]|%3D)\s*(?:\\*["'])?)[^\s&"',;}\\]+/gi;

const PAIRING_CODE_RE = /\b((?:pairing|setup)[\s_-]?code\s*[:=]?\s*)[^\s"',;}]+/gi;

const PREFIXED_TOKEN_RE =
  /\b(?:sk|pk|rk)[-_](?:live_|test_|proj-|ant-)?[A-Za-z0-9_-]{6,}|\bgh[pousr]_[A-Za-z0-9]{10,}|\bgithub_pat_[A-Za-z0-9_]{10,}|\bxox[abprs]-[A-Za-z0-9-]{6,}|\bhf_[A-Za-z0-9]{10,}|\bgsk_[A-Za-z0-9]{10,}|\bglpat-[A-Za-z0-9_-]{10,}|\bxai-[A-Za-z0-9]{10,}|\btskey-[A-Za-z0-9-]{6,}|\b(?:AKIA|ASIA)[A-Z0-9]{12,}|\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.?[A-Za-z0-9_-]*/g;

const LONG_RUN_RE = /[A-Za-z0-9_\-+/.=]{40,}/g;

function sanitizeConnectReason(message         ) {
  return String(message ?? "")
    .slice(0, MAX_INPUT_CHARS)
    .replace(URL_USERINFO_RE, "$1[REDACTED]@")
    .replace(AUTH_SCHEME_RE, "$1 [REDACTED]")
    .replace(CREDENTIAL_KEY_RE, "$1[REDACTED]")
    .replace(PAIRING_CODE_RE, "$1[REDACTED]")
    .replace(PREFIXED_TOKEN_RE, "[REDACTED]")
    .replace(LONG_RUN_RE, "[REDACTED]")
    .slice(0, MAX_REASON_CHARS);
}

module.exports = { sanitizeConnectReason };
