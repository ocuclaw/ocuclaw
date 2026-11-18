const { createPairingControlService } = require("../domain/pairing/pairing-control-service.cjs");

const { createPairingEndpointService } = require("../domain/pairing/pairing-endpoint-service.cjs");

const { createPairingExchangeHost } = require("../domain/pairing/pairing-exchange.cjs");

const { resolveNoiseSuite } = require("../domain/pairing/noise-suite.cjs");
const { createBufferedHttpResponse, decodeBufferedHttpBody } = require("./buffered-http.cjs");

function createRelayPairing(ctx                     ) {
  const { opts, logger, dispatchPairingCompleted } = ctx;

  let pairingEndpointService                                = null;
  let pairingExchangeHost                             = null;
  let pairingEndpointPromise                                                = null;

  function ensurePairingEndpoint() {
    if (pairingEndpointPromise) return pairingEndpointPromise;
    pairingEndpointPromise = (async () => {
      let noiseSuite = null;
      try {
        noiseSuite = await resolveNoiseSuite();
      } catch (err     ) {
        noiseSuite = null;
        logger.warn(
          `[ocuclaw] pairing noise suite probe failed: ${err && err.message ? err.message : err}`,
        );
      }
      if (!noiseSuite) {
        logger.warn(
          "[ocuclaw] pairing endpoint held: this runtime cannot carry the Noise handshake",
        );
        return null;
      }
      const service = createPairingEndpointService({
        onHandlerError: () => {
          logger.warn(
            "[ocuclaw] pairing endpoint handler failed; phone response stayed fail-closed",
          );
        },

        tick: () => {
          if (pairingExchangeHost) pairingExchangeHost.tick();
        },

        activeExchangeId: () => {
          try {
            const snapshot = pairingExchangeHost && pairingExchangeHost.snapshot();
            return snapshot && snapshot.exchangeId ? snapshot.exchangeId : null;
          } catch {
            return null;
          }
        },
      });
      pairingExchangeHost = createPairingExchangeHost({
        transport: service.transport,
        noiseSuite,

        readRelayCredential: () => (typeof opts.token === "string" ? opts.token : ""),

        resolveClientRole: () => "app",
        onPairingCompleted: (completionId        ) => dispatchPairingCompleted(completionId),
      });
      pairingEndpointService = service;
      return service;
    })().catch((err     ) => {

      logger.warn(
        `[ocuclaw] pairing endpoint unavailable: ${err && err.message ? err.message : err}`,
      );
      return null;
    });
    return pairingEndpointPromise;
  }

  function pairingJsonResult(status        , json         , extraHeaders                                          = null) {
    const res = createBufferedHttpResponse(opts.evenAiMaxResponseBytes || 262_144);
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");

    res.setHeader("cache-control", "no-store");

    if (extraHeaders) {
      for (const key of Object.keys(extraHeaders)) {
        res.setHeader(key, extraHeaders[key]);
      }
    }
    res.end(status === 204 ? "" : JSON.stringify(json));
    return res.toResult();
  }

  async function handleBufferedPairingHttpRequest(envelope                                         ) {
    const service = await ensurePairingEndpoint();
    if (!service) {
      return pairingJsonResult(503, { v: 1, error: "rejected" });
    }
    const headers =
      envelope && envelope.headers && typeof envelope.headers === "object"
        ? envelope.headers
        : {};
    const contentType =
      typeof headers["content-type"] === "string" ? headers["content-type"] : null;
    const body = decodeBufferedHttpBody(envelope);

    const result = await service.handleRequest({
      method: envelope && typeof envelope.method === "string" ? envelope.method : "GET",
      contentType,
      body: body.toString("utf8"),
      bodyBytes:
        envelope && Number.isFinite(envelope.bodyBytes) ? envelope.bodyBytes           : body.length,
    });
    return pairingJsonResult(result.status, result.json, result.headers);
  }

  function notePairingAuthenticatedHello(hello                                                                 ) {

    Promise.resolve(ensurePairingEndpoint())
      .then((service) => (service ? service.noteAuthenticatedHello(hello) : false))
      .catch((err     ) => {
        logger.warn(
          `[ocuclaw] pairing hello correlation failed: ${err && err.message ? err.message : err}`,
        );
      });
  }

  let pairingControlService                               = null;

  async function handleBufferedPairingControlRequest(envelope                                         ) {

    const service = await ensurePairingEndpoint();
    if (!service || !pairingExchangeHost) {
      return pairingJsonResult(503, { v: 1, error: "rejected" });
    }
    if (!pairingControlService) {
      pairingControlService = createPairingControlService({
        exchangeHost: () => pairingExchangeHost,

        readRelayCredential: () => (typeof opts.token === "string" ? opts.token : ""),

        readPhoneAddress: () => {
          let value = opts.phoneAddress;
          if (typeof opts.readPhoneAddress === "function") {
            try {
              value = opts.readPhoneAddress();
            } catch (_) {
              value = opts.phoneAddress;
            }
          }
          return typeof value === "string" && value.trim() ? value : null;
        },
      });
    }
    const headers =
      envelope && envelope.headers && typeof envelope.headers === "object"
        ? envelope.headers
        : {};
    const contentType =
      typeof headers["content-type"] === "string" ? headers["content-type"] : null;
    const body = decodeBufferedHttpBody(envelope);
    const result = await pairingControlService.handleRequest({
      method: envelope && typeof envelope.method === "string" ? envelope.method : "GET",
      contentType,
      headers,
      body: body.toString("utf8"),
      bodyBytes:
        envelope && Number.isFinite(envelope.bodyBytes) ? envelope.bodyBytes           : body.length,
    });

    return pairingJsonResult(result.status, result.json);
  }

  return {
    handleHttpRequest: handleBufferedPairingHttpRequest,
    handleControlRequest: handleBufferedPairingControlRequest,
    noteAuthenticatedHello: notePairingAuthenticatedHello,

    get endpointService() {
      return pairingEndpointService;
    },
    get exchangeHost() {
      return pairingExchangeHost;
    },
  };
}

module.exports = { createRelayPairing };
