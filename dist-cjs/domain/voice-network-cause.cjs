const CLASSES                         = {
  ENOTFOUND: "dns", EAI_AGAIN: "dns", EAI_FAIL: "dns",
  CERT_HAS_EXPIRED: "tls", DEPTH_ZERO_SELF_SIGNED_CERT: "tls",
  SELF_SIGNED_CERT_IN_CHAIN: "tls", UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "tls", ERR_TLS_CERT_ALTNAME_INVALID: "tls",
  ERR_SSL_WRONG_VERSION_NUMBER: "tls", ECONNREFUSED: "connection",
  ECONNRESET: "connection", ENETUNREACH: "connection", EHOSTUNREACH: "connection",
  EPIPE: "connection", UND_ERR_SOCKET: "connection", ETIMEDOUT: "timeout",
  UND_ERR_CONNECT_TIMEOUT: "timeout", UND_ERR_HEADERS_TIMEOUT: "timeout",
  UND_ERR_BODY_TIMEOUT: "timeout",
};

function voiceNetworkCause(error         , context

 ) {
  const seen = new Set        ();
  const codes           = [];
  let truncated = false;
  let aborted = false;
  const visit = (value         , depth        ) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    if (depth > 4 || seen.size >= 16) { truncated = true; return; }
    seen.add(value);
    const e = value                                                                         ;
    if (typeof e.code === "string" && Object.hasOwn(CLASSES, e.code) && !codes.includes(e.code)) codes.push(e.code);
    if (e.name === "AbortError" || e.name === "TimeoutError") aborted = true;
    visit(e.cause, depth + 1);
    if (Array.isArray(e.errors)) {
      if (e.errors.length > 16) truncated = true;
      for (const cause of e.errors.slice(0, 16)) visit(cause, depth + 1);
    }
  };
  visit(error, 0);
  const classes = [...new Set(codes.map(code => CLASSES[code]))];
  const httpStatus = Number.isInteger(context.httpStatus) && context.httpStatus  >= 100 && context.httpStatus  <= 599
    ? context.httpStatus : undefined;
  const failureClass = classes.length > 1 ? "mixed" : classes[0] || (aborted ? "timeout"
    : context.stage === "configuration" ? "configuration"
    : httpStatus && httpStatus >= 400 ? "http"
    : context.stage === "decode" ? "malformed_response" : "unknown");
  return { version: 1, service: context.service, stage: context.stage,
    elapsedMs: Math.max(0, Math.min(86_400_000, Math.floor(context.elapsedMs) || 0)),
    failureClass, codes, causesTruncated: truncated, ...(httpStatus === undefined ? {} : { httpStatus }) };
}

function sanitizeVoiceNetworkCause(raw     ) {
  if (!raw || raw.version !== 1) return null;
  const pick = (value     , allowed          ) => allowed.includes(value) ? value : "unknown";
  return { version: 1,
    service: pick(raw.service, ["soniox", "cartesia", "hermes"]),
    stage: pick(raw.stage, ["configuration", "connect", "headers", "body", "decode"]),
    failureClass: pick(raw.failureClass, ["dns", "tls", "connection", "timeout", "http", "configuration", "malformed_response", "mixed"]),
    elapsedMs: Number.isFinite(raw.elapsedMs) ? Math.max(0, Math.min(86_400_000, Math.floor(raw.elapsedMs))) : null,
    codes: Array.isArray(raw.codes) ? [...new Set(raw.codes.filter((code         ) => typeof code === "string" && Object.hasOwn(CLASSES, code)))].slice(0, 16) : [],
    causesTruncated: raw.causesTruncated === true,
    ...(Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599 ? { httpStatus: raw.httpStatus } : {}),
  };
}

module.exports = { voiceNetworkCause, sanitizeVoiceNetworkCause };
