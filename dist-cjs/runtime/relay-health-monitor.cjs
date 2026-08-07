const { PerformanceObserver, monitorEventLoopDelay } = require("node:perf_hooks");

const LOW_LAG_SAMPLE_THRESHOLD_MS = 50;
const LOW_LAG_HEARTBEAT_MS = 60_000;
const SPIKE_BUCKETS_MS = [250, 1_000, 5_000, 10_000];
const DEFAULT_SEND_BUFFER_HIGH_WATER_BYTES = 262_144;

function classifyFrameForRelayHealth(messageType) {
  if (
    messageType === "ping" ||
    messageType === "pong" ||
    messageType === "protocolHelloAck" ||
    messageType === "ocuclaw.sync.resume.ack" ||
    messageType === "ocuclaw.worker.health"
  ) {
    return "transport-control";
  }
  if (
    messageType === "ocuclaw.operation.received" ||
    messageType === "ocuclaw.worker.operation.received" ||
    messageType === "ocuclaw.relay.busy"
  ) {
    return "operation-control";
  }
  if (
    messageType === "ocuclaw.message.send.ack" ||
    messageType === "ocuclaw.approval.resolve.ack"
  ) {
    return "transactional";
  }
  if (
    messageType === "ocuclaw.session.switch.applied" ||
    messageType === "ocuclaw.session.config.set.ack" ||
    messageType === "ocuclaw.evenai.settings.set.ack" ||
    messageType === "ocuclaw.settings.set.ack"
  ) {
    return "latest-mutation";
  }
  if (
    messageType === "ocuclaw.runtime.status" ||
    messageType === "ocuclaw.session.list.result" ||
    messageType === "ocuclaw.provider.usage.snapshot" ||
    messageType === "ocuclaw.model.catalog.snapshot" ||
    messageType === "ocuclaw.skills.catalog.snapshot"
  ) {
    return "coalescable-read";
  }
  return "best-effort";
}

function createRelayHealthMonitor(options) {
  const now = options.now || Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const sampleIntervalMs = options.sampleIntervalMs || 1_000;
  const sendBufferHighWaterBytes =
    options.sendBufferHighWaterBytes || DEFAULT_SEND_BUFFER_HIGH_WATER_BYTES;
  let intervalId = null;
  let delayMonitor = null;
  let gcObserver = null;
  let lastLowLagEmitAtMs = null;
  const emittedSpikeBuckets = new Set();

  function defaultSampleEventLoopDelay() {
    if (!delayMonitor) {
      return { p50Ms: 0, p95Ms: 0, maxMs: 0, sampleCount: 0 };
    }
    const sample = {
      p50Ms: delayMonitor.percentile(50) / 1_000_000,
      p95Ms: delayMonitor.percentile(95) / 1_000_000,
      maxMs: delayMonitor.max / 1_000_000,
      sampleCount: Number(delayMonitor.count || 0),
    };
    delayMonitor.reset();
    return sample;
  }

  function emitLagSample() {
    const sample = options.sampleEventLoopDelay
      ? options.sampleEventLoopDelay()
      : defaultSampleEventLoopDelay();
    const nowMs = now();
    const shouldEmitLowLagHeartbeat =
      lastLowLagEmitAtMs === null || nowMs - lastLowLagEmitAtMs >= LOW_LAG_HEARTBEAT_MS;
    const shouldEmitSample =
      sample.maxMs >= LOW_LAG_SAMPLE_THRESHOLD_MS || shouldEmitLowLagHeartbeat;
    if (shouldEmitSample) {
      if (sample.maxMs < LOW_LAG_SAMPLE_THRESHOLD_MS) {
        lastLowLagEmitAtMs = nowMs;
      }
      options.emitDebug("event_loop_lag_sample", "debug", {
        p50Ms: Math.round(sample.p50Ms),
        p95Ms: Math.round(sample.p95Ms),
        maxMs: Math.round(sample.maxMs),
        sampleCount: sample.sampleCount,
        sampleIntervalMs,
      });
    }
    for (const bucketMs of SPIKE_BUCKETS_MS) {
      if (sample.maxMs >= bucketMs && !emittedSpikeBuckets.has(bucketMs)) {
        emittedSpikeBuckets.add(bucketMs);
        options.emitDebug("event_loop_lag_spike", "warn", {
          bucketMs,
          maxMs: Math.round(sample.maxMs),
          p95Ms: Math.round(sample.p95Ms),
          sampleCount: sample.sampleCount,
        });
      }
    }
    if (sample.maxMs < SPIKE_BUCKETS_MS[0]) {
      emittedSpikeBuckets.clear();
    }
  }

  function start() {
    if (intervalId !== null) return;
    lastLowLagEmitAtMs = now();
    if (!options.sampleEventLoopDelay) {
      delayMonitor = monitorEventLoopDelay({ resolution: 50 });
      delayMonitor.enable();
    }
    if (options.observeGc !== false) {
      gcObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          options.emitDebug("gc_pause", "warn", {
            durationMs: Math.round(entry.duration),
            kind: Number(entry.kind || 0),
          });
        }
      });
      gcObserver.observe({ entryTypes: ["gc"] });
    }
    intervalId = setIntervalFn(emitLagSample, sampleIntervalMs);
  }

  function stop() {
    if (intervalId !== null) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
    if (delayMonitor) {
      delayMonitor.disable();
      delayMonitor = null;
    }
    if (gcObserver) {
      gcObserver.disconnect();
      gcObserver = null;
    }
  }

  function observeSendBuffer(params) {
    if (
      params.bufferedAmountBytes !== null &&
      Number.isFinite(params.bufferedAmountBytes) &&
      params.bufferedAmountBytes >= sendBufferHighWaterBytes
    ) {
      options.emitDebug("ws_send_buffer_high_water", "warn", {
        clientId: params.clientId,
        messageType: params.messageType,
        frameClass: classifyFrameForRelayHealth(params.messageType),
        bufferedAmountBytes: params.bufferedAmountBytes,
        thresholdBytes: sendBufferHighWaterBytes,
      });
    }
  }

  function emitQueueDepth(snapshot) {
    options.emitDebug("relay_queue_depth", "debug", snapshot);
  }

  return { start, stop, observeSendBuffer, emitQueueDepth };
}

module.exports = { createRelayHealthMonitor, classifyFrameForRelayHealth };
