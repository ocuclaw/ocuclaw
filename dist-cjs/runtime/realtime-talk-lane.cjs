const { Buffer } = require("node:buffer");

const REALTIME_APP_PROTOCOL = Object.freeze({
  capabilitiesGet: "ocuclaw.voice.realtime.capabilities.get",
  capabilitiesSnapshot: "ocuclaw.voice.realtime.capabilities.snapshot",
  start: "ocuclaw.voice.realtime.start",
  startResult: "ocuclaw.voice.realtime.start.result",

  audio: "ocuclaw.voice.realtime.audio",

  interrupt: "ocuclaw.voice.realtime.interrupt",

  markAck: "ocuclaw.voice.realtime.mark.ack",
  stop: "ocuclaw.voice.realtime.stop",

  event: "ocuclaw.voice.realtime.event",
});

const REALTIME_STATUS = Object.freeze({
  ok: "ok",
  notConfigured: "not_configured",
  unsupported: "unsupported",
  warming: "warming",
  offline: "offline",
  error: "error",
});

const GLASSES_PCM_SAMPLE_RATE_HZ = 16_000;

const RELAY_DEFAULT_SAMPLE_RATE_HZ = 24_000;

const REALTIME_MAX_INFLIGHT_MS = 3_000;

const REALTIME_MAX_INPUT_CHUNK_BYTES = 64_000;

const REALTIME_OUTPUT_BATCH_MS = 100;
const REALTIME_OUTPUT_FLUSH_MS = 40;
const REALTIME_CONSULT_TIMEOUT_MS = 120_000;
const REALTIME_RPC_TIMEOUT_MS = 15_000;
const CONSULT_TOOL = "openclaw_agent_consult";

function errorMessage(err     , fallback        ) {
  const text = err && typeof err.message === "string" ? err.message.trim() : "";
  return (text || fallback).slice(0, 300);
}

function isUnknownMethod(err     ) {
  const code = err && err.code;
  const text = errorMessage(err, "").toLowerCase();
  return code === -32601 || code === "METHOD_NOT_FOUND" || text.includes("unknown method");
}

function isInvalidRequest(err     ) {
  const code = err && err.code;
  return code === "INVALID_REQUEST" || errorMessage(err, "").toLowerCase().includes("invalid");
}

function frameRequestId(msg     ) {
  return msg && typeof msg.requestId === "string" && msg.requestId ? msg.requestId.slice(0, 128) : null;
}

function createPcm16Resampler(fromHz        , toHz        ) {
  const step = fromHz / toHz;
  let pos = 0;
  let prev                = null;
  return function resample(chunk        )         {
    if (fromHz === toHz) return Buffer.from(chunk);
    const count = Math.floor(chunk.length / 2);
    if (count === 0) return Buffer.alloc(0);
    const offset = prev === null ? 0 : 1;
    const at = (i        ) => (i < offset ? (prev          ) : chunk.readInt16LE((i - offset) * 2));
    const total = count + offset;
    const out           = [];
    while (pos + 1 < total) {
      const i = Math.floor(pos);
      const frac = pos - i;
      out.push(Math.round(at(i) + (at(i + 1) - at(i)) * frac));
      pos += step;
    }

    pos -= total - 1;
    prev = at(total - 1);
    const buf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, out[i])), i * 2);
    return buf;
  };
}

function lastAssistantText(history     ) {
  const messages = Array.isArray(history) ? history : history && Array.isArray(history.messages) ? history.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
    if (typeof m.content === "string" && m.content.trim()) return m.content.trim();
    if (Array.isArray(m.content)) {
      const text = m.content
        .filter((part     ) => part && part.type === "text" && typeof part.text === "string")
        .map((part     ) => part.text)
        .join("\n\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

function summarizeRealtimeCatalog(catalog     ) {
  const group = catalog && catalog.realtime;
  const providers = group && Array.isArray(group.providers) ? group.providers : [];
  const activeId = group && typeof group.activeProvider === "string" ? group.activeProvider : "";
  const provider =
    providers.find((p     ) => p && p.id === activeId) ||
    providers.find((p     ) => p && p.configured === true) ||
    null;
  if (!provider) {
    return { status: REALTIME_STATUS.notConfigured, provider: null, model: null, voices: [], reason: "No realtime voice provider is set up on this agent" };
  }
  const transports = Array.isArray(provider.transports) ? provider.transports : [];
  const brains = Array.isArray(provider.brains) ? provider.brains : [];
  const base = {
    provider: String(provider.id).slice(0, 64),
    model: typeof provider.defaultModel === "string" ? provider.defaultModel.slice(0, 80) : null,
    voices: Array.isArray(provider.voices) ? provider.voices.filter((v     ) => typeof v === "string").slice(0, 50) : [],
  };
  if (transports.length && !transports.includes("gateway-relay")) {
    return { status: REALTIME_STATUS.unsupported, ...base, reason: "This provider cannot stream through the agent" };
  }
  if (brains.length && !brains.includes("agent-consult")) {
    return { status: REALTIME_STATUS.unsupported, ...base, reason: "This provider cannot hand questions to the agent" };
  }
  if (provider.configured !== true || (group && group.ready === false)) {
    return { status: REALTIME_STATUS.notConfigured, ...base, reason: "Voice calls need a ChatGPT sign-in or an OpenAI API key on the agent" };
  }
  return { status: REALTIME_STATUS.ok, ...base, reason: null };
}

function createRealtimeTalkLane(deps      = {}) {
  const request = typeof deps.request === "function" ? deps.request : null;
  const send = typeof deps.send === "function" ? deps.send : () => {};
  const backendKind = typeof deps.backendKind === "function" ? deps.backendKind : () => "openclaw";
  const gatewayKey = typeof deps.gatewayKey === "function" ? deps.gatewayKey : () => ({ key: "main", agentId: "" });
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const logger = deps.logger || null;
  const calls = new Map              ();
  const byRelayId = new Map              ();
  let unsubscribe      = null;

  const warn = (message        ) => {
    if (logger && typeof logger.warn === "function") logger.warn(message);
  };
  const call = (method        , params     , timeoutMs = REALTIME_RPC_TIMEOUT_MS) =>
    (request       )(method, params, { timeoutMs });

  function emit(target      , payload     ) {
    send(target.clientId, JSON.stringify({ type: REALTIME_APP_PROTOCOL.event, callId: target.relaySessionId, ...payload }));
  }

  function ensureSubscribed() {
    if (unsubscribe || typeof deps.subscribe !== "function") return;
    try {
      unsubscribe = deps.subscribe(onTalkEvent) || (() => {});
    } catch (err) {
      warn(`[realtime] cannot listen for talk events: ${errorMessage(err, "unknown")}`);
    }
  }

  async function getCapabilities() {
    if (backendKind() === "hermes") {
      return { status: REALTIME_STATUS.unsupported, provider: null, model: null, voices: [], reason: "Hermes has no realtime voice call yet" };
    }
    if (!request) return { status: REALTIME_STATUS.offline, provider: null, model: null, voices: [], reason: "The agent is not connected" };
    try {
      const { key } = gatewayKey();
      let catalog     ;
      try {
        catalog = await call("talk.catalog", key ? { sessionKey: key } : {});
      } catch (err     ) {

        if (!key || !/no session found|unexpected property 'sessionkey'/i.test(errorMessage(err, ""))) throw err;
        catalog = await call("talk.catalog", {});
      }
      return summarizeRealtimeCatalog(catalog);
    } catch (err     ) {
      if (isUnknownMethod(err)) {
        return { status: REALTIME_STATUS.unsupported, provider: null, model: null, voices: [], reason: "This OpenClaw is too old for realtime voice" };
      }
      const details = err && err.details;
      if (details && details.reason === "talk-catalog-warming") {
        return { status: REALTIME_STATUS.warming, provider: null, model: null, voices: [], reason: "The agent is still starting voice", retryAfterMs: Number(details.retryAfterMs) || 1000 };
      }
      return { status: REALTIME_STATUS.error, provider: null, model: null, voices: [], reason: errorMessage(err, "Could not read the agent's voice setup") };
    }
  }

  async function start(clientId        , msg      = {}) {
    if (backendKind() === "hermes") return { success: false, error: { code: "unsupported", message: "Hermes has no realtime voice call yet" } };
    if (!request) return { success: false, error: { code: "offline", message: "The agent is not connected" } };
    ensureSubscribed();
    const existing = calls.get(clientId);
    if (existing) await stop(clientId, "replaced");
    const { key } = gatewayKey();
    const params      = { sessionKey: key, mode: "realtime", transport: "gateway-relay", brain: "agent-consult" };
    if (typeof msg.voice === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(msg.voice)) params.voice = msg.voice;
    if (typeof msg.language === "string" && /^[a-z]{2}$/.test(msg.language)) params.language = msg.language;
    let created     ;
    try {
      created = await call("talk.session.create", params);
    } catch (err     ) {
      if (isUnknownMethod(err)) return { success: false, error: { code: "unsupported", message: "This OpenClaw is too old for realtime voice" } };
      return { success: false, error: { code: "start_failed", message: errorMessage(err, "The agent could not start a voice call") } };
    }
    const relaySessionId = created && typeof created.relaySessionId === "string" ? created.relaySessionId : created && created.sessionId;
    if (typeof relaySessionId !== "string" || !relaySessionId) {
      return { success: false, error: { code: "start_failed", message: "The agent returned no call" } };
    }
    const audio = (created && created.audio) || {};
    if ((audio.inputEncoding && audio.inputEncoding !== "pcm16") || (audio.outputEncoding && audio.outputEncoding !== "pcm16")) {
      call("talk.session.close", { sessionId: relaySessionId }).catch(() => {});
      return { success: false, error: { code: "unsupported", message: "The agent's voice call uses an audio format OcuClaw cannot play" } };
    }
    const inputRateHz = Number(audio.inputSampleRateHz) || RELAY_DEFAULT_SAMPLE_RATE_HZ;
    const outputRateHz = Number(audio.outputSampleRateHz) || RELAY_DEFAULT_SAMPLE_RATE_HZ;
    const entry       = {
      clientId,
      relaySessionId,
      sessionKey: key,
      inputRateHz,
      outputRateHz,
      resample: createPcm16Resampler(GLASSES_PCM_SAMPLE_RATE_HZ, inputRateHz),
      inflightBytes: 0,
      maxInflightBytes: Math.round((inputRateHz * 2 * REALTIME_MAX_INFLIGHT_MS) / 1000),
      dropped: 0,
      out: [],
      outBytes: 0,
      outTurnId: null,
      flushTimer: null,
      lastTurnId: null,
      consults: new Map(),
      closed: false,
    };
    calls.set(clientId, entry);
    byRelayId.set(relaySessionId, entry);
    return {
      success: true,
      callId: relaySessionId,
      provider: created.provider || null,
      model: created.model || null,
      voice: created.voice || null,

      inputSampleRateHz: GLASSES_PCM_SAMPLE_RATE_HZ,
      outputSampleRateHz: outputRateHz,
      expiresAt: Number(created.expiresAt) || null,
    };
  }

  function appendAudio(clientId        , msg      = {}) {
    const entry = calls.get(clientId);
    if (!entry || entry.closed || msg.callId !== entry.relaySessionId) return;
    const base64 = typeof msg.audioBase64 === "string" ? msg.audioBase64 : "";
    if (!base64) return;
    const raw = Buffer.from(base64, "base64");
    if (raw.length === 0 || raw.length > REALTIME_MAX_INPUT_CHUNK_BYTES) return;
    const pcm = entry.resample(raw);
    if (pcm.length === 0) return;
    if (entry.inflightBytes + pcm.length > entry.maxInflightBytes) {
      entry.dropped += 1;

      if (entry.dropped === 1) emit(entry, { kind: "audio_dropped" });
      return;
    }
    entry.dropped = 0;
    entry.inflightBytes += pcm.length;
    call("talk.session.appendAudio", { sessionId: entry.relaySessionId, audioBase64: pcm.toString("base64") })
      .catch((err     ) => warn(`[realtime] appendAudio failed: ${errorMessage(err, "unknown")}`))
      .finally(() => {
        entry.inflightBytes = Math.max(0, entry.inflightBytes - pcm.length);
      });
  }

  async function interrupt(clientId        , msg      = {}) {
    const entry = calls.get(clientId);
    if (!entry || entry.closed) return { ok: false };
    dropOutput(entry);
    try {
      const params      = { sessionId: entry.relaySessionId, reason: msg.reason === "tap" ? "tap" : "barge-in" };
      if (entry.lastTurnId) params.turnId = entry.lastTurnId;
      const result      = await call("talk.session.cancelOutput", params);
      return { ok: true, status: (result && result.status) || null };
    } catch (err     ) {
      warn(`[realtime] cancelOutput failed: ${errorMessage(err, "unknown")}`);
      return { ok: false };
    }
  }

  function acknowledgeMark(clientId        , msg      = {}) {
    const entry = calls.get(clientId);
    const markName = typeof msg.markName === "string" ? msg.markName.slice(0, 128) : "";
    if (!entry || entry.closed || !markName) return;
    call("talk.session.acknowledgeMark", { sessionId: entry.relaySessionId, markName }).catch(() => {});
  }

  function forget(entry      ) {
    entry.closed = true;
    if (entry.flushTimer) clearT(entry.flushTimer);
    entry.flushTimer = null;
    for (const consult of entry.consults.values()) consult.cancelled = true;
    entry.consults.clear();
    if (calls.get(entry.clientId) === entry) calls.delete(entry.clientId);
    byRelayId.delete(entry.relaySessionId);
  }

  async function stop(clientId        , reason = "stopped") {
    const entry = calls.get(clientId);
    if (!entry) return { ok: true };
    flushOutput(entry);
    forget(entry);

    try {
      await call("talk.session.close", { sessionId: entry.relaySessionId, disposition: "detach" });
    } catch (err     ) {

      if (isInvalidRequest(err)) await call("talk.session.close", { sessionId: entry.relaySessionId }).catch(() => {});
    }
    emit(entry, { kind: "closed", reason });
    return { ok: true };
  }

  function dropOutput(entry      ) {
    entry.out = [];
    entry.outBytes = 0;
    if (entry.flushTimer) clearT(entry.flushTimer);
    entry.flushTimer = null;
  }

  function flushOutput(entry      ) {
    if (entry.flushTimer) clearT(entry.flushTimer);
    entry.flushTimer = null;
    if (entry.outBytes === 0) return;
    const pcm = Buffer.concat(entry.out, entry.outBytes);
    entry.out = [];
    entry.outBytes = 0;
    emit(entry, { kind: "audio", turnId: entry.outTurnId, sampleRateHz: entry.outputRateHz, audioBase64: pcm.toString("base64") });
  }

  function queueOutput(entry      , base64        , turnId               ) {
    const pcm = Buffer.from(base64, "base64");
    if (pcm.length === 0) return;
    if (entry.outBytes > 0 && turnId && entry.outTurnId && turnId !== entry.outTurnId) flushOutput(entry);
    entry.out.push(pcm);
    entry.outBytes += pcm.length;
    entry.outTurnId = turnId;
    const batchBytes = Math.round((entry.outputRateHz * 2 * REALTIME_OUTPUT_BATCH_MS) / 1000);
    if (entry.outBytes >= batchBytes) {
      flushOutput(entry);
    } else if (!entry.flushTimer) {
      entry.flushTimer = setT(() => {
        entry.flushTimer = null;
        flushOutput(entry);
      }, REALTIME_OUTPUT_FLUSH_MS);
    }
  }

  async function runConsult(entry      , toolCallId        , args     ) {
    const handle = { cancelled: false };
    entry.consults.set(toolCallId, handle);
    emit(entry, { kind: "thinking" });
    const submit = (result     ) =>
      handle.cancelled || entry.closed
        ? Promise.resolve()
        : call("talk.session.submitToolResult", { sessionId: entry.relaySessionId, callId: toolCallId, result }).catch((err     ) =>
            warn(`[realtime] submitToolResult failed: ${errorMessage(err, "unknown")}`),
          );
    try {
      const parsed = typeof args === "string" ? JSON.parse(args || "{}") : args || {};
      const run      = await call("talk.client.toolCall", {
        sessionKey: entry.sessionKey,
        callId: toolCallId,
        name: CONSULT_TOOL,
        args: parsed,
        relaySessionId: entry.relaySessionId,
      });
      if (handle.cancelled || entry.closed) return;
      const runId = run && run.runId;
      if (typeof runId !== "string" || !runId) throw new Error("The agent did not start");
      const waited      = await call("agent.wait", { runId, timeoutMs: REALTIME_CONSULT_TIMEOUT_MS }, REALTIME_CONSULT_TIMEOUT_MS + 5_000);
      if (handle.cancelled || entry.closed) return;
      if (waited && waited.status === "error") throw new Error(waited.error || "The agent run failed");
      if (waited && waited.status === "timeout") throw new Error("The agent took too long");
      const history      = await call("chat.history", { sessionKey: run.agentSessionKey || entry.sessionKey, limit: 6 });
      const text = lastAssistantText(history) || "OpenClaw finished with no text.";
      await submit({ result: text });
    } catch (err     ) {
      await submit({ error: errorMessage(err, "The agent could not answer") });
    } finally {
      entry.consults.delete(toolCallId);
      if (!entry.closed) emit(entry, { kind: "listening" });
    }
  }

  function onTalkEvent(payload     ) {
    const relaySessionId = payload && typeof payload.relaySessionId === "string" ? payload.relaySessionId : "";
    const entry = relaySessionId ? byRelayId.get(relaySessionId) : null;
    if (!entry || entry.closed) return;
    const turnId = payload.talkEvent && typeof payload.talkEvent.turnId === "string" ? payload.talkEvent.turnId : null;
    if (turnId) entry.lastTurnId = turnId;
    switch (payload.type) {
      case "ready":
        emit(entry, { kind: "ready" });
        return;
      case "audio":
        if (typeof payload.audioBase64 === "string") queueOutput(entry, payload.audioBase64, turnId);
        return;
      case "audioDone":
        flushOutput(entry);
        emit(entry, { kind: "speech_done", turnId });
        return;
      case "responseStarted":
        emit(entry, { kind: "speaking", turnId });
        return;
      case "clear":
        dropOutput(entry);
        emit(entry, { kind: "clear", turnId });
        return;
      case "mark":

        flushOutput(entry);
        if (typeof payload.markName === "string") emit(entry, { kind: "mark", markName: payload.markName });
        return;
      case "transcript":
        if (typeof payload.text === "string" && payload.text) {
          emit(entry, {
            kind: "transcript",
            role: payload.role === "assistant" ? "assistant" : "user",
            text: payload.text.slice(0, 4000),
            final: payload.final === true,
            turnId,
          });
        }
        return;
      case "toolCall": {
        const toolCallId = typeof payload.callId === "string" ? payload.callId : "";
        if (!toolCallId) return;
        if (payload.name === CONSULT_TOOL) {
          void runConsult(entry, toolCallId, payload.args);
        } else {
          call("talk.session.submitToolResult", {
            sessionId: entry.relaySessionId,
            callId: toolCallId,
            result: { error: `Tool "${String(payload.name).slice(0, 64)}" is not available on the glasses` },
          }).catch(() => {});
        }
        return;
      }

      case "toolProgress": {
        const final = payload.talkEvent && payload.talkEvent.final === true;
        if (!final && !entry.delegating) {
          entry.delegating = true;
          emit(entry, { kind: "thinking" });
        } else if (final && entry.delegating) {
          entry.delegating = false;
          emit(entry, { kind: "listening" });
        }
        return;
      }
      case "toolCallCancelled": {
        const consult = typeof payload.callId === "string" ? entry.consults.get(payload.callId) : null;
        if (consult) consult.cancelled = true;
        return;
      }
      case "error":
        emit(entry, { kind: "error", message: errorMessage({ message: payload.message }, "The voice call failed") });
        return;
      case "close":
        flushOutput(entry);
        forget(entry);
        emit(entry, { kind: "closed", reason: payload.reason === "error" ? "error" : "ended" });
        return;
      default:
        return;
    }
  }

  function removeClient(clientId        ) {
    if (calls.has(clientId)) return stop(clientId, "disconnected");
    return undefined;
  }

  function dispose() {
    for (const clientId of [...calls.keys()]) void stop(clientId, "shutdown");
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  return {
    getCapabilities,
    start,
    appendAudio,
    interrupt,
    acknowledgeMark,
    stop,
    removeClient,
    dispose,

    onTalkEvent,
    activeCallCount: () => calls.size,
  };
}

function formatRealtimeCapabilities(requestId     , payload      = {}) {
  return JSON.stringify({
    type: REALTIME_APP_PROTOCOL.capabilitiesSnapshot,
    requestId: requestId || null,
    status: typeof payload.status === "string" ? payload.status : REALTIME_STATUS.offline,
    provider: payload.provider || null,
    model: payload.model || null,
    voices: Array.isArray(payload.voices) ? payload.voices : [],
    reason: payload.reason || null,
    ...(payload.retryAfterMs ? { retryAfterMs: payload.retryAfterMs } : {}),
  });
}

function formatRealtimeStartResult(requestId     , payload      = {}) {
  const frame      = { type: REALTIME_APP_PROTOCOL.startResult, requestId: requestId || null, success: payload.success === true };
  if (frame.success) {
    Object.assign(frame, {
      callId: payload.callId,
      provider: payload.provider || null,
      model: payload.model || null,
      voice: payload.voice || null,
      inputSampleRateHz: payload.inputSampleRateHz,
      outputSampleRateHz: payload.outputSampleRateHz,
      expiresAt: payload.expiresAt || null,
    });
  } else {
    frame.error = {
      code: (payload.error && payload.error.code) || "start_failed",
      message: (payload.error && payload.error.message) || "The agent could not start a voice call",
    };
  }
  return JSON.stringify(frame);
}

function createRealtimeTalkDownstreamHandlers(deps      = {}) {
  const lane = deps.lane || null;
  const isPhone = typeof deps.isPhoneClient === "function" ? deps.isPhoneClient : () => false;
  const offline = { success: false, error: { code: "offline", message: "Realtime voice is not available here" } };
  return {
    handle(clientId        , msg     )      {
      const type = msg && msg.type;
      const requestId = frameRequestId(msg);
      if (type === REALTIME_APP_PROTOCOL.capabilitiesGet) {
        const offlineCaps = { status: REALTIME_STATUS.offline, reason: "Realtime voice is not available here" };
        return Promise.resolve(lane ? lane.getCapabilities() : offlineCaps).then(
          (payload     ) => ({ unicast: formatRealtimeCapabilities(requestId, payload) }),
          () => ({ unicast: formatRealtimeCapabilities(requestId, offlineCaps) }),
        );
      }
      const allowed = Boolean(lane) && isPhone(clientId);
      switch (type) {
        case REALTIME_APP_PROTOCOL.start:
          return Promise.resolve(allowed ? lane.start(clientId, msg) : offline).then(
            (payload     ) => ({ unicast: formatRealtimeStartResult(requestId, payload) }),
            () => ({ unicast: formatRealtimeStartResult(requestId, offline) }),
          );
        case REALTIME_APP_PROTOCOL.audio:
          if (allowed) lane.appendAudio(clientId, msg);
          return null;
        case REALTIME_APP_PROTOCOL.markAck:
          if (allowed) lane.acknowledgeMark(clientId, msg);
          return null;
        case REALTIME_APP_PROTOCOL.interrupt:
          if (allowed) void lane.interrupt(clientId, msg);
          return null;
        case REALTIME_APP_PROTOCOL.stop:
          if (allowed) void lane.stop(clientId, "stopped");
          return null;
        default:
          return null;
      }
    },
  };
}

module.exports = { REALTIME_APP_PROTOCOL, REALTIME_STATUS, GLASSES_PCM_SAMPLE_RATE_HZ, RELAY_DEFAULT_SAMPLE_RATE_HZ, REALTIME_MAX_INFLIGHT_MS, REALTIME_MAX_INPUT_CHUNK_BYTES, REALTIME_OUTPUT_BATCH_MS, REALTIME_OUTPUT_FLUSH_MS, REALTIME_CONSULT_TIMEOUT_MS, REALTIME_RPC_TIMEOUT_MS, createPcm16Resampler, lastAssistantText, summarizeRealtimeCatalog, createRealtimeTalkLane, formatRealtimeCapabilities, formatRealtimeStartResult, createRealtimeTalkDownstreamHandlers };
