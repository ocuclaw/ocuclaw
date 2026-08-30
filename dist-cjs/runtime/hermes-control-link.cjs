const LINK_PROTOCOL_VERSION = 1;

const LINK_MAX_LINE_BYTES = 1_048_576;

const LINK_TRUNCATION_HEAD_CHARS = 2_048;

const LINK_HANDSHAKE_TIMEOUT_MS = 10_000;

const LINK_DEBUG_CATEGORY = "hermes.link";

const LINK_PROTOCOL = Object.freeze({
  hello: "link.hello",
  helloAck: "link.hello.ack",
  rpcRequest: "link.rpc.request",
  rpcResponse: "link.rpc.response",
});

const LINK_EXIT_CODES = Object.freeze({
  clean: 0,
  fatal: 1,
  handshakeTimeout: 3,
  protocolMismatch: 4,

  bindFailure: 98,
});

const RPC_METHOD_NOT_FOUND_CODE = -32601;

const LINK_REQUEST_TIMEOUT_CODE = "link_request_timeout";

function createLinkRequestTimeoutError(method, timeoutMs) {
  const err = new Error(
    `control link request timed out after ${timeoutMs}ms (${method})`,
  );
  err.name = "LinkRequestTimeoutError";
  err.code = LINK_REQUEST_TIMEOUT_CODE;
  err.reason = LINK_REQUEST_TIMEOUT_CODE;
  err.method = method;
  err.timeoutMs = timeoutMs;
  return err;
}

function encodeLinkFrame(frame) {
  const line = JSON.stringify(frame);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes <= LINK_MAX_LINE_BYTES) {
    return { line: `${line}\n`, truncated: false, originalBytes: bytes };
  }
  const marker = { v: frame.v, type: frame.type };
  if (frame.id !== undefined) marker.id = frame.id;
  if (frame.method !== undefined) marker.method = frame.method;
  if (frame.ok !== undefined) marker.ok = frame.ok;
  marker.truncated = true;
  marker.originalBytes = bytes;
  marker.payloadHead = line.slice(0, LINK_TRUNCATION_HEAD_CHARS);
  const markerLine = JSON.stringify(marker);
  return {
    line: `${markerLine}\n`,
    truncated: true,
    originalBytes: bytes,
  };
}

function createNdjsonLineSplitter(opts) {
  const maxLineBytes =
    opts && Number.isFinite(opts.maxLineBytes) && opts.maxLineBytes > 0
      ? opts.maxLineBytes
      : LINK_MAX_LINE_BYTES;
  const onLine = opts && typeof opts.onLine === "function" ? opts.onLine : () => {};
  const onOversize =
    opts && typeof opts.onOversize === "function" ? opts.onOversize : () => {};
  let pending = Buffer.alloc(0);
  let discardingBytes = 0;

  function feed(chunk) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
    while (true) {
      const nl = pending.indexOf(10);
      if (nl === -1) {
        if (discardingBytes > 0) {
          discardingBytes += pending.length;
          pending = Buffer.alloc(0);
        } else if (pending.length > maxLineBytes) {
          discardingBytes = pending.length;
          pending = Buffer.alloc(0);
        }
        return;
      }
      const lineBuf = pending.subarray(0, nl);
      pending = pending.subarray(nl + 1);
      if (discardingBytes > 0) {
        onOversize(discardingBytes + lineBuf.length);
        discardingBytes = 0;
        continue;
      }
      if (lineBuf.length > maxLineBytes) {
        onOversize(lineBuf.length);
        continue;
      }
      if (lineBuf.length === 0) {
        continue;
      }
      onLine(lineBuf.toString("utf8"));
    }
  }

  return { feed };
}

function summarizeFrame(frame, originalBytes) {
  const summary = { type: frame.type, bytes: originalBytes };
  if (frame.id !== undefined) summary.id = frame.id;
  if (frame.method !== undefined) summary.method = frame.method;
  if (frame.ok !== undefined) summary.ok = frame.ok;
  if (frame.truncated === true) summary.truncated = true;
  return summary;
}

function createHermesControlLink(opts) {
  const input = opts.input;
  const output = opts.output;
  const logger = opts.logger || console;
  let emitDebug =
    typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const methods = opts.methods || {};
  const helloPayload = opts.hello || {};

  const counters = {
    framesIn: 0,
    framesOut: 0,
    truncatedOutbound: 0,
    oversizedInbound: 0,
    protocolErrors: 0,
    requestTimeouts: 0,
    lateResponses: 0,
  };

  let ready = false;
  let closed = false;
  let nextRequestId = 1;
  const pendingRequests = new Map();

  const timedOutRequestIds = new Set();
  const TIMED_OUT_REQUEST_ID_LIMIT = 256;
  function rememberTimedOutRequest(id) {
    timedOutRequestIds.add(id);
    while (timedOutRequestIds.size > TIMED_OUT_REQUEST_ID_LIMIT) {
      const oldest = timedOutRequestIds.values().next().value;
      timedOutRequestIds.delete(oldest);
    }
  }
  const closeHandlers = [];
  let handshake = null;

  function mirror(event, data) {
    try {
      emitDebug(LINK_DEBUG_CATEGORY, event, data);
    } catch (_) {

    }
  }

  function writeFrame(frame) {
    if (closed) return false;
    const encoded = encodeLinkFrame(frame);
    if (encoded.truncated) {
      counters.truncatedOutbound += 1;
      logger.warn(
        `[hermes-link] outbound ${frame.type} truncated (${encoded.originalBytes} bytes > ${LINK_MAX_LINE_BYTES})`,
      );
    }
    counters.framesOut += 1;
    mirror("frame_out", summarizeFrame(frame, encoded.originalBytes));
    output.write(encoded.line);
    return !encoded.truncated;
  }

  function respondError(id, code, message) {
    writeFrame({
      v: LINK_PROTOCOL_VERSION,
      type: LINK_PROTOCOL.rpcResponse,
      id,
      ok: false,
      error: { code, message },
    });
  }

  async function handleRequest(frame) {
    const method = typeof frame.method === "string" ? frame.method : "";
    const handler = Object.prototype.hasOwnProperty.call(methods, method)
      ? methods[method]
      : null;
    if (!handler) {
      respondError(
        frame.id,
        RPC_METHOD_NOT_FOUND_CODE,
        `method not found: ${method || "<missing>"}`,
      );
      return;
    }
    try {
      const result = await handler(frame.params);
      writeFrame({
        v: LINK_PROTOCOL_VERSION,
        type: LINK_PROTOCOL.rpcResponse,
        id: frame.id,
        ok: true,
        result: result === undefined ? null : result,
      });
    } catch (err) {
      respondError(frame.id, -32000, err && err.message ? err.message : String(err));
    }
  }

  function handleResponse(frame) {
    const entry = pendingRequests.get(frame.id);
    if (!entry) {
      if (timedOutRequestIds.delete(frame.id)) {
        counters.lateResponses += 1;
        mirror("late_response", { id: frame.id });
        return;
      }
      counters.protocolErrors += 1;
      mirror("protocol_error", { reason: "unmatched_response", id: frame.id });
      return;
    }
    pendingRequests.delete(frame.id);
    if (frame.truncated === true) {
      entry.reject(new Error("link_frame_truncated"));
      return;
    }
    if (frame.ok === true) {
      entry.resolve(frame.result);
    } else {
      const error = frame.error || {};
      const err = new Error(error.message || "link rpc failed");
      err.code = error.code;
      entry.reject(err);
    }
  }

  function handleFrame(frame) {
    counters.framesIn += 1;
    mirror("frame_in", summarizeFrame(frame, 0));
    if (frame.v !== LINK_PROTOCOL_VERSION) {
      counters.protocolErrors += 1;
      mirror("protocol_error", { reason: "version_mismatch", got: frame.v });
      if (!ready && handshake) {
        const err = new Error(
          `link protocol version mismatch: peer sent v=${frame.v}, expected v=${LINK_PROTOCOL_VERSION}`,
        );
        err.exitCode = LINK_EXIT_CODES.protocolMismatch;
        handshake.reject(err);
      } else {
        logger.warn(
          `[hermes-link] dropping frame with protocol version ${frame.v}`,
        );
      }
      return;
    }
    if (!ready) {
      if (frame.type === LINK_PROTOCOL.helloAck) {
        ready = true;
        if (handshake) handshake.resolve(frame.payload || {});
        return;
      }
      counters.protocolErrors += 1;
      mirror("protocol_error", { reason: "frame_before_hello_ack", type: frame.type });
      logger.warn(
        `[hermes-link] dropping pre-handshake frame ${frame.type || "<untyped>"}`,
      );
      return;
    }
    if (frame.type === LINK_PROTOCOL.rpcRequest) {
      handleRequest(frame);
      return;
    }
    if (frame.type === LINK_PROTOCOL.rpcResponse) {
      handleResponse(frame);
      return;
    }
    counters.protocolErrors += 1;
    mirror("protocol_error", { reason: "unknown_frame_type", type: frame.type });
    logger.warn(`[hermes-link] unknown frame type ${frame.type || "<untyped>"}`);
  }

  const splitter = createNdjsonLineSplitter({
    maxLineBytes: LINK_MAX_LINE_BYTES,
    onLine(line) {
      let frame = null;
      try {
        frame = JSON.parse(line);
      } catch (_) {
        counters.protocolErrors += 1;
        mirror("protocol_error", { reason: "invalid_json", head: line.slice(0, 128) });
        logger.warn("[hermes-link] dropping non-JSON line on control link");
        return;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
        counters.protocolErrors += 1;
        mirror("protocol_error", { reason: "non_object_frame" });
        return;
      }
      handleFrame(frame);
    },
    onOversize(bytes) {
      counters.oversizedInbound += 1;
      counters.protocolErrors += 1;
      mirror("protocol_error", { reason: "oversized_inbound", bytes });
      logger.warn(
        `[hermes-link] dropped oversized inbound line (${bytes} bytes > ${LINK_MAX_LINE_BYTES})`,
      );
    },
  });

  function onData(chunk) {
    splitter.feed(chunk);
  }

  function onEnd() {
    if (closed) return;
    closed = true;
    ready = false;
    mirror("link_closed", { reason: "input_eof" });
    if (handshake) {
      const err = new Error("control link closed before handshake completed");
      err.exitCode = LINK_EXIT_CODES.fatal;
      handshake.reject(err);
    }
    for (const entry of pendingRequests.values()) {
      entry.reject(new Error("control link closed"));
    }
    pendingRequests.clear();
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch (_) {

      }
    }
  }

  function start(startOpts) {
    const timeoutMs =
      startOpts && Number.isFinite(startOpts.handshakeTimeoutMs)
        ? startOpts.handshakeTimeoutMs
        : LINK_HANDSHAKE_TIMEOUT_MS;
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    const helloPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(
          `link handshake timed out after ${timeoutMs}ms waiting for ${LINK_PROTOCOL.helloAck}`,
        );
        err.exitCode = LINK_EXIT_CODES.handshakeTimeout;
        handshake = null;
        reject(err);
      }, timeoutMs);
      handshake = {
        resolve(payload) {
          clearTimeout(timer);
          handshake = null;
          resolve(payload);
        },
        reject(err) {
          clearTimeout(timer);
          handshake = null;
          reject(err);
        },
      };
    });
    writeFrame({
      v: LINK_PROTOCOL_VERSION,
      type: LINK_PROTOCOL.hello,
      payload: {
        pid: process.pid,
        runtimeName: "ocuclaw-runtime",
        ...helloPayload,
      },
    });
    return helloPromise;
  }

  function request(method, params, requestOpts = undefined) {
    if (closed) {
      return Promise.reject(new Error("control link closed"));
    }
    if (!ready) {
      return Promise.reject(new Error("control link not ready"));
    }
    const rawTimeout = requestOpts ? requestOpts.timeoutMs : undefined;
    const timeoutMs =
      Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : 0;
    const id = `n${nextRequestId++}`;
    return new Promise((resolve, reject) => {
      let timer = null;
      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      pendingRequests.set(id, {
        resolve: (value) => {
          clearTimer();
          resolve(value);
        },
        reject: (err) => {
          clearTimer();
          reject(err);
        },
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timer = null;
          if (!pendingRequests.has(id)) return;
          pendingRequests.delete(id);

          rememberTimedOutRequest(id);
          counters.requestTimeouts += 1;
          mirror("request_timeout", { id, method, timeoutMs });
          logger.warn(
            `[hermes-link] ${method} timed out after ${timeoutMs}ms (peer alive, no response)`,
          );
          reject(createLinkRequestTimeoutError(method, timeoutMs));
        }, timeoutMs);

        if (timer && typeof timer.unref === "function") timer.unref();
      }
      const delivered = writeFrame({
        v: LINK_PROTOCOL_VERSION,
        type: LINK_PROTOCOL.rpcRequest,
        id,
        method,
        params,
      });
      if (!delivered) {
        const entry = pendingRequests.get(id);
        pendingRequests.delete(id);
        if (entry) entry.reject(new Error("link_frame_truncated"));
        else {
          clearTimer();
          reject(new Error("link_frame_truncated"));
        }
      }
    });
  }

  function onClose(handler) {
    if (typeof handler === "function") closeHandlers.push(handler);
  }

  function setDebugEmitter(nextEmitDebug) {
    emitDebug =
      typeof nextEmitDebug === "function" ? nextEmitDebug : () => {};
  }

  function stop() {
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    onEnd();
  }

  return {
    start,
    stop,
    request,
    onClose,
    setDebugEmitter,
    isReady: () => ready,
    getCounters: () => ({ ...counters }),
  };
}

module.exports = { LINK_PROTOCOL_VERSION, LINK_MAX_LINE_BYTES, LINK_TRUNCATION_HEAD_CHARS, LINK_HANDSHAKE_TIMEOUT_MS, LINK_DEBUG_CATEGORY, LINK_PROTOCOL, LINK_EXIT_CODES, RPC_METHOD_NOT_FOUND_CODE, LINK_REQUEST_TIMEOUT_CODE, createLinkRequestTimeoutError, encodeLinkFrame, createNdjsonLineSplitter, createHermesControlLink };
