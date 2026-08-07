const { LINK_PROTOCOL_VERSION } = require("./hermes-control-link.cjs");

const HERMES_SYNTH_TICK_INTERVAL_MS = 15000;

function createHermesRuntimeReadiness(opts) {
  const dispatchBackendEvent = opts && opts.dispatchBackendEvent;
  if (typeof dispatchBackendEvent !== "function") {
    throw new Error(
      "hermes runtime readiness requires a dispatchBackendEvent function",
    );
  }
  const logger = (opts && opts.logger) || console;

  let helloOk = null;

  function getHelloOk() {
    return helloOk;
  }

  function announceReady(ackPayload) {
    helloOk = {
      protocol: LINK_PROTOCOL_VERSION,
      policy: { tickIntervalMs: HERMES_SYNTH_TICK_INTERVAL_MS },
    };
    if (ackPayload && typeof ackPayload.hermesVersion === "string") {
      helloOk.hermesVersion = ackPayload.hermesVersion;
    }
    dispatchBackendEvent("connected", {
      protocol: helloOk.protocol,
      tickIntervalMs: helloOk.policy.tickIntervalMs,
    });
    dispatchBackendEvent("status", "connected");
    return helloOk;
  }

  function announceFailure(reason) {
    const message =
      typeof reason === "string" && reason
        ? reason
        : (reason && reason.message) || "hermes runtime startup failed";
    logger.warn(`[hermes-readiness] connect failed: ${message}`);
    dispatchBackendEvent("connectFailed", { reason: message });
  }

  function announceDisconnected(reason) {
    const message = typeof reason === "string" && reason ? reason : "link_closed";
    dispatchBackendEvent("disconnected", { reason: message });
    dispatchBackendEvent("status", "disconnected");
  }

  return {
    getHelloOk,
    announceReady,
    announceFailure,
    announceDisconnected,
  };
}

module.exports = { HERMES_SYNTH_TICK_INTERVAL_MS, createHermesRuntimeReadiness };
