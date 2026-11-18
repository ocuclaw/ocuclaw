const { EventEmitter } = require("node:events");

function decodeBufferedHttpBody(envelope                                         ) {
  return Buffer.from((envelope && envelope.bodyBase64) || "", "base64");
}

function createBufferedHttpRequest(envelope                                         ) {
  const req = new EventEmitter()                       ;
  req.method = envelope && envelope.method ? envelope.method : "GET";
  req.url = envelope && envelope.url ? envelope.url : "/";
  req.headers = envelope && envelope.headers && typeof envelope.headers === "object"
    ? envelope.headers
    : {};
  req.socket = {
    remoteAddress: "127.0.0.1",
  };
  const body = decodeBufferedHttpBody(envelope);
  process.nextTick(() => {
    if (body.length > 0) {
      req.emit("data", body);
    }
    req.emit("end");
  });
  return req;
}

function createBufferedHttpResponse(maxResponseBytes        ) {
  const headers                          = {};
  const chunks           = [];
  let totalBytes = 0;
  const limit = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
    ? Math.floor(maxResponseBytes)
    : 262_144;

  const res = new EventEmitter()                        ;
  res.statusCode = 200;
  res.writableEnded = false;
  res.setHeader = function (name, value) {
    if (typeof name === "string" && name) {
      headers[name.toLowerCase()] = value;
    }
  };
  res.getHeader = function (name) {
    return typeof name === "string" ? headers[name.toLowerCase()] : undefined;
  };
  res.write = function (chunk) {
    if (this.writableEnded) return false;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""));
    totalBytes += buffer.length;
    if (totalBytes > limit) {
      throw new Error("Buffered HTTP response exceeded relay worker limit");
    }
    chunks.push(buffer);
    return true;
  };
  res.end = function (chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    this.writableEnded = true;
  };
  res.toResult = function () {
    return {
      statusCode: this.statusCode,
      headers: { ...headers },
      body: Buffer.concat(chunks),
    };
  };
  return res;
}

module.exports = { decodeBufferedHttpBody, createBufferedHttpRequest, createBufferedHttpResponse };
