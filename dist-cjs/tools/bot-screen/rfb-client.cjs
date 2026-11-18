const RFB_ENCODING_RAW = 0;
const RFB_ENCODING_COPYRECT = 1;
const RFB_ENCODING_DESKTOP_SIZE = -223;

const RFB_ENCODINGS = Object.freeze([RFB_ENCODING_COPYRECT, RFB_ENCODING_RAW, RFB_ENCODING_DESKTOP_SIZE]);

const RFB_WATCH_ONLY_TYPES = Object.freeze([0, 2, 3]);

const RFB_INPUT_TYPES = Object.freeze([4, 5, 6, 251, 255]);

const RFB_HANDSHAKE_BYTES = 12 + 1 + 1;

const RFB_MAX_SIDE = 8192;

const MAX_CUT_TEXT = 16 * 1024 * 1024;
const DEFAULT_MIN_REQUEST_MS = 80;

function watchOnlyMessage(message            )             {
  if (!message || message.length === 0 || !RFB_WATCH_ONLY_TYPES.includes(message[0])) {
    throw new Error(`bot screen: refused RFB client message type ${message && message.length ? message[0] : "none"}`);
  }
  return message;
}

function setPixelFormatMessage()         {
  const m = Buffer.alloc(20);
  m[0] = 0;
  m[4] = 32;
  m[5] = 24;
  m[6] = 0;
  m[7] = 1;
  m.writeUInt16BE(255, 8);
  m.writeUInt16BE(255, 10);
  m.writeUInt16BE(255, 12);
  m[14] = 16;
  m[15] = 8;
  m[16] = 0;
  return m;
}

function setEncodingsMessage(encodings                    = RFB_ENCODINGS)         {
  const m = Buffer.alloc(4 + 4 * encodings.length);
  m[0] = 2;
  m.writeUInt16BE(encodings.length, 2);
  encodings.forEach((enc, i) => m.writeInt32BE(enc, 4 + 4 * i));
  return m;
}

function updateRequestMessage(incremental         , width        , height        )         {
  const m = Buffer.alloc(10);
  m[0] = 3;
  m[1] = incremental ? 1 : 0;
  m.writeUInt16BE(width, 6);
  m.writeUInt16BE(height, 8);
  return m;
}

function probeRequestMessage() {
  return updateRequestMessage(false, 1, 1);
}

class ByteQueue {
          chunks           = [];
  length = 0;

  push(chunk        )       {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  peek(n        )         {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    for (const c of this.chunks) {
      if (filled >= n) break;
      const k = Math.min(c.length, n - filled);
      c.copy(out, filled, 0, k);
      filled += k;
    }
    return out;
  }

  take(n        )         {
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - filled);
      c.copy(out, filled, 0, k);
      filled += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.length -= n;
    return out;
  }

  drop(n        )         {
    let dropped = 0;
    while (dropped < n && this.chunks.length) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - dropped);
      dropped += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.length -= dropped;
    return dropped;
  }
}

function createRfbClient(opts                  )            {
  const now = opts.now || (() => Date.now());
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const minRequestMs = Math.max(0, opts.minRequestMs ?? DEFAULT_MIN_REQUEST_MS);
  const sock = opts.connect();
  const queue = new ByteQueue();
  let stage        = "version";
  let width = 0;
  let height = 0;
  let fb = new Uint8Array(0);
  let rgb = new Uint8Array(0);

  let rgbWhole = false;
  let rgbArea = 0;
  let colourWanted = false;
  let rect          = { x: 0, y: 0, w: 0, h: 0 };
  let rectsLeft = 0;
  let painted            = [];
  let copies = 0;
  let resized = false;
  let skipLeft = 0;
  let closed = false;
  let paused = false;
  let ready = false;
  let wantRequest = false;
  let needFull = true;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let requestTimer      = null;
  let updates = 0;
  let rectCount = 0;
  let bytesIn = 0;
  let probes = 0;
  let lastUpdateAt = Number.NEGATIVE_INFINITY;

  function write(message            )       {
    if (closed) return;
    sock.write(watchOnlyMessage(message));
  }

  function end(reason               )       {
    if (closed) return;
    closed = true;
    if (requestTimer !== null) clearTimeoutFn(requestTimer);
    requestTimer = null;
    try {
      sock.destroy();
    } catch {

    }
    fb = new Uint8Array(0);
    rgb = new Uint8Array(0);
    rgbWhole = false;
    colourWanted = false;
    opts.onEnd(reason);
  }

  function sendRequest()       {
    requestTimer = null;
    if (closed || paused || !wantRequest) return;
    wantRequest = false;
    lastRequestAt = now();
    const full = needFull;
    needFull = false;
    write(updateRequestMessage(!full, width, height));
  }

  function scheduleRequest()       {
    wantRequest = true;
    if (closed || paused || requestTimer !== null) return;
    const wait = Math.max(0, lastRequestAt + minRequestMs - now());
    if (wait === 0) sendRequest();
    else requestTimer = setTimeoutFn(sendRequest, wait);
  }

  function inside(r         )          {
    return r.x + r.w <= width && r.y + r.h <= height;
  }

  function rectDone(r         , changed = true)       {
    if (changed) painted.push(r);
    rectCount++;
    if (--rectsLeft > 0) {
      stage = "rect";
      return;
    }
    finishUpdate();
  }

  function finishUpdate()       {
    stage = "message";
    updates++;
    lastUpdateAt = now();
    const update            = { rects: painted, copies, resized, width, height };
    if (!rgbWhole && rgbArea >= width * height) rgbWhole = true;
    rgbArea = 0;
    painted = [];
    copies = 0;
    resized = false;
    if (update.rects.length) opts.onUpdate(update);
    if (!closed) scheduleRequest();
  }

  function resize(w        , h        )          {
    if (w <= 0 || h <= 0 || w > RFB_MAX_SIDE || h > RFB_MAX_SIDE) return false;
    width = w;
    height = h;
    fb = new Uint8Array(w * h);
    rgb = new Uint8Array(w * h * 3);
    rgbWhole = false;
    rgbArea = 0;
    return true;
  }

  function parse()       {
    while (!closed) {
      switch (stage) {
        case "version": {
          if (queue.length < 12) return;
          if (!/^RFB \d{3}\.\d{3}\n$/.test(queue.take(12).toString("latin1"))) return end("not_rfb");
          sock.write("RFB 003.008\n");
          stage = "security";
          break;
        }
        case "security": {
          if (queue.length < 1) return;
          const n = queue.peek(1)[0];
          if (n === 0) return end("security_refused");
          if (queue.length < 1 + n) return;
          const types = [...queue.take(1 + n).subarray(1)];
          if (!types.includes(1)) return end("security_not_none");
          sock.write(Buffer.from([1]));
          stage = "result";
          break;
        }
        case "result": {
          if (queue.length < 4) return;
          if (queue.take(4).readUInt32BE(0) !== 0) return end("security_failed");

          sock.write(Buffer.from([1]));
          stage = "init";
          break;
        }
        case "init": {
          if (queue.length < 24) return;
          const nameLen = queue.peek(24).readUInt32BE(20);
          if (nameLen > 4096) return end("protocol");
          if (queue.length < 24 + nameLen) return;
          const head = queue.take(24 + nameLen);
          if (!resize(head.readUInt16BE(0), head.readUInt16BE(2))) return end("size_refused");
          write(setPixelFormatMessage());
          write(setEncodingsMessage());
          ready = true;
          stage = "message";
          if (opts.onReady) opts.onReady({ width, height });
          needFull = true;
          scheduleRequest();
          break;
        }
        case "message": {
          if (queue.length < 1) return;
          const type = queue.peek(1)[0];
          if (type === 0) {
            if (queue.length < 4) return;
            rectsLeft = queue.take(4).readUInt16BE(2);
            if (rectsLeft === 0) finishUpdate();
            else stage = "rect";
          } else if (type === 1) {

            if (queue.length < 6) return;
            skipLeft = queue.take(6).readUInt16BE(4) * 6;
            stage = "skip";
          } else if (type === 2) {
            queue.take(1);
          } else if (type === 3) {

            if (queue.length < 8) return;
            const n = queue.take(8).readInt32BE(4);
            if (Math.abs(n) > MAX_CUT_TEXT) return end("protocol");
            skipLeft = Math.abs(n);
            stage = "skip";
          } else {
            return end(`unknown_message_${type}`);
          }
          break;
        }
        case "skip": {
          skipLeft -= queue.drop(skipLeft);
          if (skipLeft > 0) return;
          stage = "message";
          break;
        }
        case "rect": {
          if (queue.length < 12) return;
          const head = queue.take(12);
          rect = { x: head.readUInt16BE(0), y: head.readUInt16BE(2), w: head.readUInt16BE(4), h: head.readUInt16BE(6) };
          const enc = head.readInt32BE(8);
          if (enc === RFB_ENCODING_DESKTOP_SIZE) {
            if (!resize(rect.w, rect.h)) return end("size_refused");
            resized = true;
            needFull = true;
            painted = [];
            rectDone({ x: 0, y: 0, w: width, h: height });
          } else if (enc === RFB_ENCODING_RAW) {
            if (!inside(rect)) return end("protocol");
            stage = "raw";
          } else if (enc === RFB_ENCODING_COPYRECT) {
            if (!inside(rect)) return end("protocol");
            stage = "copy";
          } else {
            return end(`unknown_encoding_${enc}`);
          }
          break;
        }
        case "raw": {
          const r = rect;
          const need = r.w * r.h * 4;
          if (queue.length < need) return;
          const px = queue.take(need);
          let changed = false;
          for (let yy = 0; yy < r.h; yy++) {
            const row = (r.y + yy) * width + r.x;
            let p = yy * r.w * 4;
            for (let xx = 0; xx < r.w; xx++, p += 4) {

              const grey = (px[p + 2] * 77 + px[p + 1] * 150 + px[p] * 29) >> 8;
              if (fb[row + xx] !== grey) {
                fb[row + xx] = grey;
                changed = true;
              }
              const c = (row + xx) * 3;
              if (rgb[c] !== px[p + 2] || rgb[c + 1] !== px[p + 1] || rgb[c + 2] !== px[p]) {
                rgb[c] = px[p + 2];
                rgb[c + 1] = px[p + 1];
                rgb[c + 2] = px[p];
                changed = true;
              }
            }
          }
          rgbArea += r.w * r.h;
          rectDone(r, changed);
          break;
        }
        case "copy": {
          if (queue.length < 4) return;
          const from = queue.take(4);
          const r = rect;
          const sx = from.readUInt16BE(0);
          const sy = from.readUInt16BE(2);
          if (sx + r.w > width || sy + r.h > height) return end("protocol");
          const tmp = new Uint8Array(r.w * r.h);
          for (let yy = 0; yy < r.h; yy++) tmp.set(fb.subarray((sy + yy) * width + sx, (sy + yy) * width + sx + r.w), yy * r.w);
          for (let yy = 0; yy < r.h; yy++) fb.set(tmp.subarray(yy * r.w, (yy + 1) * r.w), (r.y + yy) * width + r.x);
          const span = r.w * 3;
          const tmpRgb = new Uint8Array(span * r.h);
          for (let yy = 0; yy < r.h; yy++) {
            const s = ((sy + yy) * width + sx) * 3;
            tmpRgb.set(rgb.subarray(s, s + span), yy * span);
          }
          for (let yy = 0; yy < r.h; yy++) rgb.set(tmpRgb.subarray(yy * span, (yy + 1) * span), ((r.y + yy) * width + r.x) * 3);
          copies++;
          rectDone(r);
          break;
        }
      }
    }
  }

  sock.on("data", (chunk        ) => {
    if (closed) return;
    bytesIn += chunk.length;
    queue.push(chunk);
    try {
      parse();
    } catch (err     ) {
      end(String((err && err.message) || err).slice(0, 120));
    }
  });
  sock.on("error", (err     ) => end(String((err && err.code) || "socket_error")));
  sock.on("close", () => end(null));

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    get lastUpdateAt() {
      return lastUpdateAt;
    },
    framebuffer: () => fb,
    framebufferRgb: () => rgb,
    keepColour(on         ) {
      colourWanted = on && !closed;
      if (!colourWanted || rgbWhole) return;

      if (ready && !paused) write(updateRequestMessage(false, width, height));
      else needFull = true;
    },
    colour: () => (colourWanted && rgbWhole ? { rgb, w: width, h: height } : null),
    probe() {
      if (closed || paused || !ready) return false;

      write(probeRequestMessage());
      probes++;
      return true;
    },
    pause() {
      paused = true;
      if (requestTimer !== null) clearTimeoutFn(requestTimer);
      requestTimer = null;
    },
    resume() {
      if (!paused) return;
      paused = false;
      if (ready && wantRequest) scheduleRequest();
    },
    close() {
      end("closed");
    },
    stats: () => ({ updates, rects: rectCount, bytes: bytesIn, probes }),
  };
}

module.exports = { RFB_ENCODING_RAW, RFB_ENCODING_COPYRECT, RFB_ENCODING_DESKTOP_SIZE, RFB_ENCODINGS, RFB_WATCH_ONLY_TYPES, RFB_INPUT_TYPES, RFB_HANDSHAKE_BYTES, RFB_MAX_SIDE, watchOnlyMessage, setPixelFormatMessage, setEncodingsMessage, updateRequestMessage, probeRequestMessage, createRfbClient };
