const net = require("node:net");

const SOCKS_VERSION = 0x05;
const SOCKS_NO_AUTH = 0x00;
const SOCKS_CMD_CONNECT = 0x01;
const SOCKS_ATYP_IPV4 = 0x01;
const SOCKS_ATYP_DOMAIN = 0x03;
const SOCKS_ATYP_IPV6 = 0x04;
const SOCKS_REPLY_SUCCEEDED = 0x00;

const SOCKS_REFUSAL_REPLIES = new Set([0x03, 0x04, 0x05]);

const LOOPBACK_PROXY_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parseSocks5(value     ) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const separator = trimmed.lastIndexOf(":");
  if (separator <= 0) return null;
  const host = trimmed.slice(0, separator).replace(/^\[|\]$/g, "").trim().toLowerCase();
  if (!LOOPBACK_PROXY_HOSTS.has(host)) return null;
  const portText = trimmed.slice(separator + 1).trim();
  if (!/^[0-9]{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function failure(message     , code     ) {
  const error      = new Error(message);
  error.code = code;
  return error;
}

function encodeDomain(host     ) {
  if (typeof host !== "string" || !host.trim()) return null;
  const bytes = Buffer.from(host.trim(), "utf8");
  if (bytes.length < 1 || bytes.length > 255) return null;
  return bytes;
}

function socks5Request(domain     , port     ) {
  const head = Buffer.from([SOCKS_VERSION, SOCKS_CMD_CONNECT, 0x00, SOCKS_ATYP_DOMAIN, domain.length]);
  const tail = Buffer.alloc(2);
  tail.writeUInt16BE(port, 0);
  return Buffer.concat([head, domain, tail]);
}

function boundAddressLength(atyp     , buffered     ) {
  if (atyp === SOCKS_ATYP_IPV4) return 4 + 2;
  if (atyp === SOCKS_ATYP_IPV6) return 16 + 2;
  if (atyp === SOCKS_ATYP_DOMAIN) {
    if (buffered.length < 5) return null;
    return 1 + buffered[4] + 2;
  }
  return -1;
}

function connectThroughSocks5(socks5     , host     , port     , timeoutMs     ) {
  return new Promise((resolve, reject) => {
    const domain = encodeDomain(host);
    if (!domain) {
      reject(failure("SOCKS5 domain name is empty or too long", "ENOTFOUND"));
      return;
    }
    let settled = false;
    let stage = "greeting";
    let buffered = Buffer.alloc(0);
    const socket = net.connect({ host: socks5.host, port: socks5.port });
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.setTimeout(0);
      socket.removeListener("timeout", onTimeout);
    };
    const fail = (error     ) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket.destroy(); } catch (_) {  }
      reject(error);
    };
    const succeed = (rest     ) => {
      if (settled) return;
      settled = true;
      socket.pause();
      cleanup();

      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    const onError = (error     ) => fail(error);
    const onTimeout = () => fail(failure("SOCKS5 handshake timed out", "ETIMEDOUT"));
    const onClose = () => fail(failure("SOCKS5 proxy closed during the handshake", "ECONNRESET"));
    function onData(chunk     ) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      if (stage === "greeting") {
        if (buffered.length < 2) return;
        if (buffered[0] !== SOCKS_VERSION || buffered[1] !== SOCKS_NO_AUTH) {
          fail(failure("SOCKS5 proxy refused the no-auth method", "ECONNRESET"));
          return;
        }
        buffered = buffered.subarray(2);
        stage = "reply";
        socket.write(socks5Request(domain, port));
      }
      if (stage !== "reply") return;
      if (buffered.length < 4) return;
      if (buffered[0] !== SOCKS_VERSION) {
        fail(failure("SOCKS5 proxy answered with a foreign version", "ECONNRESET"));
        return;
      }
      const reply = buffered[1];
      const extra = boundAddressLength(buffered[3], buffered);
      if (extra === -1) {
        fail(failure("SOCKS5 proxy answered with an unknown address type", "ECONNRESET"));
        return;
      }
      if (extra === null) return;
      if (buffered.length < 4 + extra) return;

      const rest = buffered.subarray(4 + extra);
      buffered = Buffer.alloc(0);
      if (reply !== SOCKS_REPLY_SUCCEEDED) {
        const code = SOCKS_REFUSAL_REPLIES.has(reply) ? "ECONNREFUSED" : "ECONNRESET";
        fail(failure(`SOCKS5 CONNECT failed (reply ${reply})`, code));
        return;
      }
      succeed(rest);
    }
    socket.setTimeout(timeoutMs, onTimeout);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.on("data", onData);
    socket.once("connect", () => {
      socket.write(Buffer.from([SOCKS_VERSION, 1, SOCKS_NO_AUTH]));
    });
  });
}

function connectDirect(host     , port     , timeoutMs     ) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host, port });
    const fail = (error     ) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      try { socket.destroy(); } catch (_) {  }
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(failure("tailnet dial timed out", "ETIMEDOUT")));
    socket.once("error", fail);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener("error", fail);
      resolve(socket);
    });
  });
}

function dialTailnet(options      = {}) {
  const host = options.host;
  const port = Number(options.port);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.reject(failure("tailnet dial port out of range", "ERR_OUT_OF_RANGE"));
  }
  const socks5 = options.socks5 && typeof options.socks5 === "object"
    ? options.socks5
    : parseSocks5(options.socks5);
  if (!socks5) return connectDirect(host, port, timeoutMs);
  return connectThroughSocks5(socks5, host, port, timeoutMs);
}

module.exports = { parseSocks5, dialTailnet };
