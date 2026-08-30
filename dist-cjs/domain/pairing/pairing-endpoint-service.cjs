const { PAIRING_ENDPOINT_CONTENT_TYPE, PAIRING_MAX_REQUEST_BODY_BYTES } = require("./pairing-endpoint-address.cjs");

const PAIRING_MAX_POSTS_PER_WINDOW = 12;
const PAIRING_RATE_WINDOW_MS = 60_000;

const PAIRING_ENDPOINT_PROTOCOL_VERSION = 1;

const CORS_HEADERS                                   = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
});

                                                                             

function refusal(status        )                              {
  return {
    status,
    json: { v: PAIRING_ENDPOINT_PROTOCOL_VERSION, error: "rejected" },
    headers: CORS_HEADERS,
  };
}

                                                                        
                                                                

const recentPosts           = [];

function resetPairingRateLimitForTests()       {
  recentPosts.length = 0;
}

function createPairingEndpointService(
  options                                = {},
)                         {
  const now = options.now ?? (() => Date.now());
  const activeExchangeId = options.activeExchangeId ?? (() => null);
  const tickHost = options.tick ?? (() => {});
  const onHandlerError = options.onHandlerError ?? (() => {});

  const outbox                = [];
  let nextOutboxSequence = 0;
  let frameHandler                                                         = null;
  let closed = false;

  let requestInFlight = false;

  let lastTaggedExchangeId                = null;

  function withinRateLimit()          {
    const cutoff = now() - PAIRING_RATE_WINDOW_MS;
    while (recentPosts.length > 0 && (recentPosts[0]          ) < cutoff) {
      recentPosts.shift();
    }
    return recentPosts.length < PAIRING_MAX_POSTS_PER_WINDOW;
  }

  const transport                   = {
    send(frame) {
      if (closed) throw new Error("pairing endpoint is closed");
      const copy = JSON.parse(JSON.stringify(frame))                ;
      const tag = typeof copy.exchangeId === "string" ? copy.exchangeId : null;

      if (
        tag !== null &&
        lastTaggedExchangeId !== null &&
        tag !== lastTaggedExchangeId &&
        tag === activeExchangeId()
      ) {
        for (let i = outbox.length - 1; i >= 0; i -= 1) {
          if ((outbox[i]               ).exchangeId !== tag) outbox.splice(i, 1);
        }
      }
      if (tag !== null && tag === activeExchangeId()) lastTaggedExchangeId = tag;

      if (tag !== null && (copy.type === "pairing.failed" || copy.type === "pairing.rejected")) {
        for (let i = outbox.length - 1; i >= 0; i -= 1) {
          const entry = outbox[i]               ;
          if (entry.exchangeId === tag && entry.frame.type === "pairing.credential") {
            outbox.splice(i, 1);
          }
        }
      }

      const liveForWrite = activeExchangeId();
      if (tag !== null && tag !== liveForWrite) {
        return;
      }

      outbox.push({ sequence: ++nextOutboxSequence, exchangeId: tag, frame: copy });
    },
    onFrame(handler) {
      frameHandler = handler;
    },
    close() {
      closed = true;
      outbox.length = 0;
    },
  };

  async function deliverToCore(frame              )                {
    const handler = frameHandler;
    if (!handler) return;
    try {
      await handler(frame);
    } catch (error) {

      try {
        onHandlerError(error);
      } catch {

      }
    }
  }

  async function handleRequest(
    request                            ,
  )                                       {

    const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
    if (method === "OPTIONS") {

      return { status: 204, json: {}, headers: CORS_HEADERS };
    }
    if (method !== "POST") {
      return refusal(405);
    }
    const mediaType = (request.contentType ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType !== PAIRING_ENDPOINT_CONTENT_TYPE) {
      return refusal(415);
    }
    if (
      typeof request.bodyBytes !== "number" ||
      request.bodyBytes > PAIRING_MAX_REQUEST_BODY_BYTES
    ) {
      return refusal(413);
    }

    if (!withinRateLimit()) {

      return refusal(429);
    }
    if (requestInFlight) {

      return refusal(429);
    }

    recentPosts.push(now());

    try {
      tickHost();
    } catch {

      requestInFlight = false;
      return refusal(503);
    }

    requestInFlight = true;
    try {
      let parsed         ;
      try {
        parsed = JSON.parse(request.body);
      } catch {
        return refusal(400);
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return refusal(400);
      }
      const envelope = parsed                           ;
      if (envelope.v !== PAIRING_ENDPOINT_PROTOCOL_VERSION) {
        return refusal(400);
      }

      const frame = envelope.frame;
      let type = "";
      let claimedExchangeId                = null;

      let producedAfterSequence = nextOutboxSequence;

      if (frame !== undefined) {
        if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
          return refusal(400);
        }
        const fields = frame                           ;
        if (typeof fields.type !== "string") return refusal(400);
        type = fields.type;
        claimedExchangeId =
          typeof fields.exchangeId === "string" ? fields.exchangeId : null;

        if (type === "pairing.completed") {
          return refusal(400);
        }

        if (type !== "pairing.poll") {
          producedAfterSequence = nextOutboxSequence;
          await deliverToCore(frame                );
        }
      }

      const live = activeExchangeId();
      const owns =
        claimedExchangeId !== null && live !== null && claimedExchangeId === live;

      let frames                 = [];
      if (owns) {

        frames = outbox
          .filter((entry) => entry.exchangeId === null || entry.exchangeId === claimedExchangeId)
          .map((entry) => JSON.parse(JSON.stringify(entry.frame))                );
      } else if (type === "pairing.manual-request") {

        const CLAIMABLE = new Set(["pairing.offer", "pairing.rejected"]);
        const claimed                = [];
        for (let i = outbox.length - 1; i >= 0; i -= 1) {
          const entry = outbox[i]               ;
          if (entry.sequence <= producedAfterSequence) continue;
          const isOwnUntaggedFailure =
            entry.frame.type === "pairing.failed" && entry.exchangeId === null;
          if (!CLAIMABLE.has(String(entry.frame.type)) && !isOwnUntaggedFailure) continue;
          claimed.unshift(entry);
          outbox.splice(i, 1);
        }
        frames = claimed.map((entry) => entry.frame);
      }

      return {
        status: 200,
        json: { v: PAIRING_ENDPOINT_PROTOCOL_VERSION, frames },
        headers: CORS_HEADERS,
      };
    } finally {
      requestInFlight = false;
    }
  }

  async function noteAuthenticatedHello(hello

   )                   {
    const exchangeId = hello?.exchangeId;
    const confirmation = hello?.confirmation;
    if (typeof exchangeId !== "string" || typeof confirmation !== "string") return false;
    if (!frameHandler) return false;

    await deliverToCore({
      type: "pairing.completed",
      exchangeId,
      confirmation,
    }                );
    return true;
  }

  return { handleRequest, noteAuthenticatedHello, transport };
}

module.exports = { PAIRING_MAX_POSTS_PER_WINDOW, PAIRING_RATE_WINDOW_MS, PAIRING_ENDPOINT_PROTOCOL_VERSION, createPairingEndpointService, resetPairingRateLimitForTests };
