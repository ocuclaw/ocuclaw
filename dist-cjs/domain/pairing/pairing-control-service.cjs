const { PAIRING_CONTROL_MAX_REQUEST_BODY_BYTES, PAIRING_ENDPOINT_CONTENT_TYPE } = require("./pairing-endpoint-address.cjs");

const { randomBytes: nodeRandomBytes } = require("node:crypto");

const { constantTimeEqual } = require("../constant-time-equal.cjs");
const { renderPairingBootstrap, pairingBootstrapPayloadText } = require("./pairing-bootstrap-presenter.cjs");

const PAIRING_CONTROL_PROTOCOL_VERSION = 1;

const PAIRING_CONTROL_AUTH_HEADER = "x-ocuclaw-pair-control-auth";

const PAIRING_CONTROL_SECRET_HEADER = "x-ocuclaw-pair-control-secret";

const PAIRING_CONTROL_MAX_REQUESTS_PER_WINDOW = 240;
const PAIRING_CONTROL_RATE_WINDOW_MS = 60_000;

const CONTROL_SECRET_BYTES = 32;

function refusal(status        )                             {
  return {
    status,
    json: { v: PAIRING_CONTROL_PROTOCOL_VERSION, error: "rejected" },
  };
}

function toBase64Url(bytes            )         {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function defaultRandomBytes(size        )             {
  return new Uint8Array(nodeRandomBytes(size));
}

const recentControlRequests           = [];

function resetPairingControlRateLimitForTests()       {
  recentControlRequests.length = 0;
}

function readHeader(
  headers                                   ,
  name        ,
)                {
  const raw = headers ? headers[name] : null;
  if (typeof raw === "string") return raw;

  return null;
}

function createPairingControlService(
  options                              ,
)                        {
  const now = options.now ?? (() => Date.now());
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const { exchangeHost, readRelayCredential } = options;

  let session                                                = null;

  function withinRateLimit()          {
    const at = now();
    const cutoff = at - PAIRING_CONTROL_RATE_WINDOW_MS;
    while (recentControlRequests.length > 0 && recentControlRequests[0] <= cutoff) {
      recentControlRequests.shift();
    }
    if (recentControlRequests.length >= PAIRING_CONTROL_MAX_REQUESTS_PER_WINDOW) {
      return false;
    }
    recentControlRequests.push(at);
    return true;
  }

  function retireIfTerminal(snapshot                 )       {
    if (!session) return;
    if (snapshot.exchangeId !== session.exchangeId) {
      session = null;
      return;
    }
    if (snapshot.state === "completed" || snapshot.state === "failed") {
      session = null;
    }
  }

  function authorizeSession(
    request                           ,
  )                                                   {
    const live = session;
    if (!live) return { ok: false };
    const supplied = readHeader(request.headers, PAIRING_CONTROL_SECRET_HEADER);
    if (supplied === null || !constantTimeEqual(supplied, live.secret)) {
      return { ok: false };
    }
    return { ok: true, exchangeId: live.exchangeId };
  }

  async function handleRequest(
    request                           ,
  )                                      {

    if (typeof request.method !== "string" || request.method.toUpperCase() !== "POST") {
      return refusal(405);
    }

    const contentType = (request.contentType || "").split(";")[0].trim().toLowerCase();
    if (contentType !== PAIRING_ENDPOINT_CONTENT_TYPE) {
      return refusal(415);
    }

    if (
      !Number.isFinite(request.bodyBytes) ||
      request.bodyBytes > PAIRING_CONTROL_MAX_REQUEST_BODY_BYTES
    ) {
      return refusal(413);
    }

    const credential = readRelayCredential();
    const presented = readHeader(request.headers, PAIRING_CONTROL_AUTH_HEADER);
    if (
      typeof credential !== "string" ||
      credential.length === 0 ||
      presented === null ||
      !constantTimeEqual(presented, credential)
    ) {
      return refusal(401);
    }

    if (!withinRateLimit()) {
      return refusal(429);
    }

    let parsed     ;
    try {
      parsed = JSON.parse(request.body);
    } catch {
      return refusal(400);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return refusal(400);
    }
    if (parsed.v !== PAIRING_CONTROL_PROTOCOL_VERSION) {
      return refusal(400);
    }

    const host = exchangeHost();
    if (!host) {

      return refusal(503);
    }

    const op = typeof parsed.op === "string" ? parsed.op : null;

    if (op === "create") {
      const address = typeof parsed.address === "string" ? parsed.address : "";
      const started = await host.beginBootstrapInitiation({ address });
      if (!started.ok) {

        return {
          status: 409,
          json: {
            v: PAIRING_CONTROL_PROTOCOL_VERSION,
            error: "rejected",
            reason: started.reason,
            message: started.message,
          },
        };
      }

      let secret        ;
      try {
        const drawn = randomBytes(CONTROL_SECRET_BYTES);
        if (!(drawn instanceof Uint8Array) || drawn.length !== CONTROL_SECRET_BYTES) {
          throw new Error("short draw");
        }
        secret = toBase64Url(drawn);
      } catch {

        host.cancel(started.exchangeId);
        return refusal(503);
      }

      session = { exchangeId: started.exchangeId, secret };

      return {
        status: 200,
        json: {
          v: PAIRING_CONTROL_PROTOCOL_VERSION,
          exchangeId: started.exchangeId,

          controlSecret: secret,

          bootstrapBlock: renderPairingBootstrap({
            qrPayload: started.qrPayload,
            pairingCode: started.pairingCode,
            expiresInSeconds: started.expiresInSeconds,
            lightTerminal: parsed.lightTerminal === true,
          }),

          payloadText: pairingBootstrapPayloadText(started.qrPayload),
          expiresInSeconds: started.expiresInSeconds,
        },
      };
    }

    if (op === "state") {
      const authorized = authorizeSession(request);
      if (!authorized.ok) return refusal(401);

      host.tick();
      const snapshot = host.snapshot();
      const prompt = host.approvalPrompt();
      retireIfTerminal(snapshot);
      return {
        status: 200,
        json: {
          v: PAIRING_CONTROL_PROTOCOL_VERSION,
          state: snapshot.state,
          exchangeId: snapshot.exchangeId,
          submissionsRemaining: snapshot.submissionsRemaining,
          approved: snapshot.approved,
          credentialExposure: snapshot.credentialExposure,
          failure: snapshot.failure
            ? { reason: snapshot.failure.reason, message: snapshot.failure.message }
            : null,

          prompt: prompt
            ? {
                exchangeId: prompt.exchangeId,
                phoneLabel: prompt.phoneLabel,
                safetyPhrase: [...prompt.safetyPhrase],
                safetyPhraseText: prompt.safetyPhraseText,
              }
            : null,
        },
      };
    }

    if (op === "approve" || op === "deny" || op === "cancel") {
      const authorized = authorizeSession(request);
      if (!authorized.ok) return refusal(401);

      const target = authorized.exchangeId;
      const result =
        op === "approve"
          ? await host.approve(target)
          : op === "deny"
            ? host.deny(target)
            : host.cancel(target);

      host.tick();
      const snapshot = host.snapshot();
      retireIfTerminal(snapshot);

      return {
        status: 200,
        json: {
          v: PAIRING_CONTROL_PROTOCOL_VERSION,
          ok: result.ok,
          reason: result.ok ? null : result.reason,
          message: result.ok ? null : result.message,
          state: snapshot.state,
          credentialExposure: snapshot.credentialExposure,

          failure: snapshot.failure
            ? { reason: snapshot.failure.reason, message: snapshot.failure.message }
            : null,
        },
      };
    }

    return refusal(400);
  }

  return { handleRequest };
}

module.exports = { PAIRING_CONTROL_PROTOCOL_VERSION, PAIRING_CONTROL_AUTH_HEADER, PAIRING_CONTROL_SECRET_HEADER, PAIRING_CONTROL_MAX_REQUESTS_PER_WINDOW, PAIRING_CONTROL_RATE_WINDOW_MS, createPairingControlService, resetPairingControlRateLimitForTests };
