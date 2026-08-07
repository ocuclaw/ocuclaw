const DEFAULT_RECOVERED_HOLD_MS = 3_000;
const DEFAULT_STALE_MS = 5_000;

function createGlassesBackpressureLatch(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const recoveredHoldMs = Number.isFinite(options.recoveredHoldMs)
    ? options.recoveredHoldMs
    : DEFAULT_RECOVERED_HOLD_MS;
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS;
  const emitDebug = typeof options.emitDebug === "function" ? options.emitDebug : () => {};

  let latched = false;
  let latchedAtMs = null;
  let lastOverAtMs = null;
  let lastReportAtMs = null;
  let workerEpoch = null;

  function clearState() {
    latched = false;
    latchedAtMs = null;
    lastOverAtMs = null;
    lastReportAtMs = null;
  }

  function emitTransition(nextLatched, reason, atMs) {
    if (nextLatched === latched) return;
    if (nextLatched) {
      latchedAtMs = atMs;
      emitDebug("glasses_backpressure_latched", "warn", { reason });
    } else {
      emitDebug("glasses_backpressure_cleared", "info", {
        reason,
        latchedForMs: latchedAtMs === null ? null : Math.max(0, atMs - latchedAtMs),
      });
      latchedAtMs = null;
    }
    latched = nextLatched;
  }

  function evaluate(atMs) {
    if (!latched) return;
    if (lastReportAtMs !== null && atMs - lastReportAtMs > staleMs) {
      emitTransition(false, "stale_reports", atMs);
      return;
    }
    if (
      lastOverAtMs !== null &&
      atMs - lastOverAtMs >= recoveredHoldMs &&
      lastReportAtMs !== null &&
      lastReportAtMs > lastOverAtMs
    ) {

      emitTransition(false, "recovered", atMs);
    }
  }

  function report(params) {
    const atMs = now();
    const count =
      params && Number.isFinite(params.sendBufferHighWaterClients)
        ? params.sendBufferHighWaterClients
        : null;
    if (count === null) return;
    const epoch = params && Number.isFinite(params.workerEpoch) ? params.workerEpoch : null;
    if (epoch !== null && workerEpoch !== null && epoch !== workerEpoch) {

      clearState();
    }
    if (epoch !== null) workerEpoch = epoch;
    lastReportAtMs = atMs;
    if (count >= 1) {
      lastOverAtMs = atMs;
      emitTransition(true, "over_high_water", atMs);
      return;
    }
    evaluate(atMs);
  }

  function isOverHighWater() {
    evaluate(now());
    return latched;
  }

  function reset(reason) {
    const atMs = now();
    emitTransition(false, typeof reason === "string" ? reason : "reset", atMs);
    clearState();
  }

  return { report, isOverHighWater, reset };
}

module.exports = { createGlassesBackpressureLatch };
