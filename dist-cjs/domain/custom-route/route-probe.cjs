const { createHmac } = require("node:crypto");
const { constantTimeEqual } = require("../constant-time-equal.cjs");

const ROUTE_PROBE_PATH = "/_ocuclaw/route-probe/v1";

const ROUTE_PROBE_NONCE_PARAM = "n";

const ROUTE_PROBE_NONCE_MIN_LENGTH = 16;
const ROUTE_PROBE_NONCE_MAX_LENGTH = 128;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/;

const ROUTE_PROBE_KEY_LABEL = "ocuclaw route-probe key v1";
const ROUTE_PROBE_MAC_LABEL = "ocuclaw route-probe v1\n";

const ROUTE_PROBE_MAX_REQUESTS_PER_WINDOW = 12;
const ROUTE_PROBE_RATE_WINDOW_MS = 60_000;

function checkRouteProbeNonce(value         )                       {
  if (value === null || value === undefined) return { ok: false, rejection: "missing" };
  if (typeof value !== "string") return { ok: false, rejection: "invalid-characters" };
  if (value.length === 0) return { ok: false, rejection: "empty" };
  if (value.length > ROUTE_PROBE_NONCE_MAX_LENGTH) return { ok: false, rejection: "too-long" };
  if (!NONCE_PATTERN.test(value)) return { ok: false, rejection: "invalid-characters" };
  if (value.length < ROUTE_PROBE_NONCE_MIN_LENGTH) return { ok: false, rejection: "too-short" };
  return { ok: true, nonce: value };
}

function deriveRouteProbeKey(relayCredential        ) {
  if (typeof relayCredential !== "string" || relayCredential.length === 0) {
    throw new Error("route probe needs a Relay Credential");
  }
  return createHmac("sha256", relayCredential)
    .update(ROUTE_PROBE_KEY_LABEL, "utf8")
    .digest();
}

function routeProbeMac(relayCredential        , nonce        )         {
  return createHmac("sha256", deriveRouteProbeKey(relayCredential))
    .update(ROUTE_PROBE_MAC_LABEL + nonce, "utf8")
    .digest("hex");
}

function routeProbeAnswerMatches(relayCredential        , nonce        , answer         )          {
  if (typeof answer !== "string" || !/^[0-9a-f]{64}$/.test(answer)) return false;
  return constantTimeEqual(routeProbeMac(relayCredential, nonce), answer);
}

function createRouteProbeRateLimiter(now               = () => Date.now()) {
  const recent           = [];
  return {

    take()          {
      const cutoff = now() - ROUTE_PROBE_RATE_WINDOW_MS;
      while (recent.length > 0 && (recent[0]          ) <= cutoff) recent.shift();
      if (recent.length >= ROUTE_PROBE_MAX_REQUESTS_PER_WINDOW) return false;
      recent.push(now());
      return true;
    },
  };
}

module.exports = { ROUTE_PROBE_PATH, ROUTE_PROBE_NONCE_PARAM, ROUTE_PROBE_NONCE_MIN_LENGTH, ROUTE_PROBE_NONCE_MAX_LENGTH, ROUTE_PROBE_KEY_LABEL, ROUTE_PROBE_MAC_LABEL, ROUTE_PROBE_MAX_REQUESTS_PER_WINDOW, ROUTE_PROBE_RATE_WINDOW_MS, checkRouteProbeNonce, deriveRouteProbeKey, routeProbeMac, routeProbeAnswerMatches, createRouteProbeRateLimiter };
