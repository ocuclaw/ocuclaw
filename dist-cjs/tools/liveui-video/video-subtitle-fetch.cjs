const { Buffer } = require("node:buffer");
const dns = require("node:dns");
const net = require("node:net");
const tls = require("node:tls");
const { Agent, EnvHttpProxyAgent, Pool, ProxyAgent, fetch: undiciFetch } = require("undici");
const { isForbiddenHttpDestination, makeSafeLookup } = require("../glasses-ui-recipes.cjs");

function aborted(signal             )       { if (signal.aborted) throw new Error("subtitle request aborted"); }
function abortable   (promise            , signal             )             {
  if (signal.aborted) return Promise.reject(new Error("subtitle request aborted"));
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("subtitle request aborted"));
    signal.addEventListener("abort", stop, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", stop); resolve(value); }, (error) => { signal.removeEventListener("abort", stop); reject(error); });
  });
}

async function connectVideoSubtitleSocks(
  proxy     , address        , port        , signal             , connect                     = net.connect,
)                      {
  if (!/^socks(?:4a?|5h?):$/.test(proxy.protocol) || !net.isIP(address) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid subtitle proxy route");
  if (isForbiddenHttpDestination(`https://${net.isIP(address) === 6 ? `[${address}]` : address}/`)) throw new Error("subtitle target refused");
  aborted(signal);
  const socket = connect({ host: proxy.hostname.replace(/^\[|\]$/g, ""), port: Number(proxy.port || 1080) });
  let buffered = Buffer.alloc(0), failure               = null;
  let wake                      = null;
  const fail = (error       ) => { failure ||= error; socket.destroy(); wake?.(); };
  const onData = (chunk        ) => {
    if (buffered.length + chunk.length > 8192) { fail(new Error("subtitle proxy handshake too large")); return; }
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    wake?.();
  };
  const onError = (error       ) => { failure ||= error; wake?.(); };
  const onClose = () => { failure ||= new Error("subtitle proxy closed"); wake?.(); };
  const onAbort = () => fail(new Error("subtitle request aborted"));
  const deadline = setTimeout(() => fail(new Error("subtitle proxy timeout")), 6000);
  socket.on("data", onData); socket.on("error", onError); socket.on("close", onClose);
  signal.addEventListener("abort", onAbort, { once: true });
  async function read(size        )                  {
    while (buffered.length < size && !failure) await new Promise      ((resolve) => { wake = resolve; });
    wake = null;
    if (failure) throw failure;
    const result = Buffer.from(buffered.subarray(0, size));
    buffered = Buffer.from(buffered.subarray(size));
    return result;
  }
  try {
    if (proxy.protocol.startsWith("socks5")) {
      const username = Buffer.from(decodeURIComponent(proxy.username)), password = Buffer.from(decodeURIComponent(proxy.password));
      if (username.length > 255 || password.length > 255) throw new Error("subtitle proxy credentials too long");
      const authenticate = username.length > 0 || password.length > 0;
      socket.write(Buffer.from(authenticate ? [5, 2, 0, 2] : [5, 1, 0]));
      const greeting = await read(2);
      if (greeting[0] !== 5 || (greeting[1] !== 0 && !(authenticate && greeting[1] === 2))) throw new Error("subtitle proxy authentication refused");
      if (greeting[1] === 2) {
        socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
        const auth = await read(2);
        if (auth[0] !== 1 || auth[1] !== 0) throw new Error("subtitle proxy authentication refused");
      }

      const target = Buffer.from(address), tail = Buffer.alloc(2); tail.writeUInt16BE(port);
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, target.length]), target, tail]));
      const header = await read(4);
      if (header[0] !== 5 || header[1] !== 0 || header[2] !== 0) throw new Error("subtitle proxy CONNECT refused");
      const bytes = header[3] === 1 ? 4 : header[3] === 4 ? 16 : header[3] === 3 ? (await read(1))[0] : -1;
      if (bytes < 0) throw new Error("subtitle proxy address invalid");
      await read(bytes + 2);
    } else {
      if (net.isIP(address) !== 4 || proxy.password) throw new Error("subtitle SOCKS4 requires IPv4 and no password");
      const user = Buffer.from(decodeURIComponent(proxy.username));
      if (user.length > 255 || user.includes(0)) throw new Error("subtitle SOCKS4 user invalid");
      const header = Buffer.alloc(8); header[0] = 4; header[1] = 1; header.writeUInt16BE(port, 2);
      header.set(address.split(".").map(Number), 4);
      socket.write(Buffer.concat([header, user, Buffer.from([0])]));
      const response = await read(8);
      if (response[0] !== 0 || response[1] !== 90) throw new Error("subtitle SOCKS4 CONNECT refused");
    }
    aborted(signal);
    socket.pause();
    return socket;
  } catch (error) { socket.destroy(); throw error; }
  finally {
    clearTimeout(deadline); signal.removeEventListener("abort", onAbort);
    socket.removeListener("data", onData); socket.removeListener("error", onError); socket.removeListener("close", onClose);
    if (!socket.destroyed && buffered.length) socket.unshift(buffered);
  }
}

function createVideoSubtitleFetch(options                              = {}) {
  const safeLookup = makeSafeLookup(options.lookup || dns.promises.lookup);
  async function targetAddress(hostname        , signal             , ipv4 = false)                  {
    aborted(signal);
    const host = hostname.replace(/^\[|\]$/g, "");
    if (isForbiddenHttpDestination(`https://${net.isIP(host) === 6 ? `[${host}]` : host}/`)) throw new Error("subtitle target refused");
    const answers        = await abortable(new Promise((resolve, reject) => safeLookup(host, { all: true, family: ipv4 ? 4 : 0 }, (error              , values     ) => error ? reject(error) : resolve(values))), signal);
    if (!answers.length) throw new Error("subtitle target unresolved");
    return answers[0].address;
  }
  return async (url        , init                        )               => {
    if (isForbiddenHttpDestination(url) || new URL(url).username || new URL(url).password) throw new Error("subtitle target refused");
    let dispatcher     ;

    const clientFactory = (origin     , opts        ) => {
      const pool      = new Pool(origin, opts);
      const connect = pool.connect.bind(pool);
      pool.connect = async (request     ) => {
        const destination = new URL(`https://${request.path}`);
        const address = await targetAddress(destination.hostname, init.signal);
        const authority = `${net.isIP(address) === 6 ? `[${address}]` : address}:${destination.port || 443}`;
        return connect({ ...request, path: authority });
      };
      return pool;
    };
    if (init.proxy && /^socks(?:4a?|5h?):/i.test(init.proxy)) {
      const proxy = new URL(init.proxy);
      dispatcher = new Agent({ connections: 1, connect: (connection     , callback     ) => {
        (async () => {
          const address = await targetAddress(connection.hostname, init.signal, proxy.protocol.startsWith("socks4"));
          const socket = await connectVideoSubtitleSocks(proxy, address, Number(connection.port || (connection.protocol === "https:" ? 443 : 80)), init.signal, options.connect);
          if (init.signal.aborted) { socket.destroy(); throw new Error("subtitle request aborted"); }
          if (connection.protocol !== "https:") { socket.resume(); callback(null, socket); return; }
          const secure = tls.connect({ socket, host: connection.hostname, servername: net.isIP(connection.hostname) ? undefined : connection.hostname, ALPNProtocols: ["http/1.1"] });
          let settled = false;
          const stop = () => secure.destroy(new Error("subtitle request aborted"));
          init.signal.addEventListener("abort", stop, { once: true });
          const done = (error        ) => {
            if (settled) return; settled = true; init.signal.removeEventListener("abort", stop);
            if (error) { secure.destroy(); callback(error, null); } else callback(null, secure);
          };
          secure.once("secureConnect", () => done()); secure.once("error", done);
        })().catch((error) => callback(error, null));
      } });
    } else if (init.proxy) {
      if (!/^https?:/i.test(init.proxy)) throw new Error("subtitle proxy protocol refused");
      dispatcher = new ProxyAgent({ uri: init.proxy, clientFactory });
    } else {

      dispatcher = new EnvHttpProxyAgent({ connect: { lookup: safeLookup }, clientFactory }       );
    }
    const stop = () => { dispatcher.destroy().catch(() => undefined); };
    const cleanup = () => { init.signal.removeEventListener("abort", stop); stop(); };
    init.signal.addEventListener("abort", stop, { once: true });
    try {
      aborted(init.signal);
      const response = await undiciFetch(url, { headers: init.headers, signal: init.signal, redirect: "manual", dispatcher });
      const reader = response.body?.getReader();
      if (!reader) { cleanup(); return { status: response.status, headers: response.headers, body: null }; }
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (item.done) { controller.close(); cleanup(); } else controller.enqueue(item.value);
          } catch (error) { controller.error(error); cleanup(); }
        },
        async cancel() { cleanup(); await reader.cancel(); },
      });
      return { status: response.status, headers: response.headers, body };
    } catch (error) { cleanup(); throw error; }
  };
}

module.exports = { connectVideoSubtitleSocks, createVideoSubtitleFetch };
