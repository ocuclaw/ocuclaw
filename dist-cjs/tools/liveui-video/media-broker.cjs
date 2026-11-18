const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const { Buffer } = require("node:buffer");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { isForbiddenHttpDestination, makeSafeLookup } = require("../glasses-ui-recipes.cjs");

const MAX_CONNECTIONS = 32;
const CONNECT_MS = 10000;

const IDLE_MS = 120000;

function target(host        , port        )       {
  if (!host || host.length > 253 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid media destination");
  const url = new URL(`http://${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname.replace(/^\[|\]$/g, "") !== host.toLowerCase() || isForbiddenHttpDestination(url.href)) {
    throw new Error("Media destination is not public");
  }
}

async function connected(socket     , secure = false)               {
  await new Promise      ((resolve, reject) => {
    const event = secure ? "secureConnect" : "connect";
    const cleanup = () => { socket.off(event, ready); socket.off("error", fail); socket.off("close", closed); };
    const ready = () => { cleanup(); resolve(); };
    const fail = (error       ) => { cleanup(); reject(error); };
    const closed = () => fail(new Error("Media route closed"));
    socket.once(event, ready); socket.once("error", fail); socket.once("close", closed);
  });
  return socket;
}

async function readBytes(socket     , size        )               {
  for (;;) {
    const value = socket.read(size);
    if (value) return value;
    if (socket.destroyed || socket.readableEnded) throw new Error("Media route closed");
    await new Promise      ((resolve, reject) => {
      const cleanup = () => { socket.off("readable", ready); socket.off("error", fail); socket.off("end", ended); socket.off("close", ended); };
      const ready = () => { cleanup(); resolve(); };
      const fail = (error       ) => { cleanup(); reject(error); };
      const ended = () => fail(new Error("Media route closed"));
      socket.once("readable", ready); socket.once("error", fail); socket.once("end", ended); socket.once("close", ended);
    });
  }
}

async function throughProxy(
  route     , pinned                                     , port        , own                      , signal             ,
)               {
  const proxyHost = route.hostname.replace(/^\[|\]$/g, "");
  const socket = own(route.protocol === "https:"
    ? tls.connect({ host: proxyHost, port: Number(route.port || 443), servername: net.isIP(proxyHost) ? undefined : proxyHost, signal })
    : net.connect({ host: proxyHost, port: Number(route.port || (route.protocol.startsWith("socks") ? 1080 : 80)), signal }));
  await connected(socket, route.protocol === "https:");
  const username = decodeURIComponent(route.username), password = decodeURIComponent(route.password);
  if (route.protocol.startsWith("socks5")) {
    socket.write(Buffer.from(username || password ? [5, 2, 0, 2] : [5, 1, 0]));
    const greeting = await readBytes(socket, 2);
    if (greeting[0] !== 5 || (greeting[1] !== 0 && greeting[1] !== 2)) throw new Error("Media SOCKS route refused");
    if (greeting[1] === 2) {
      const user = Buffer.from(username), pass = Buffer.from(password);
      if (user.length > 255 || pass.length > 255) throw new Error("Media SOCKS credentials too long");
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await readBytes(socket, 2);
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error("Media SOCKS authentication refused");
    }

    const address = Buffer.from(pinned.address), wirePort = Buffer.alloc(2); wirePort.writeUInt16BE(port);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, address.length]), address, wirePort]));
    const reply = await readBytes(socket, 4);
    if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error("Media SOCKS connect refused");
    const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readBytes(socket, 1))[0] : -1;
    if (length < 0) throw new Error("Invalid media SOCKS reply");
    await readBytes(socket, length + 2);
  } else if (route.protocol.startsWith("socks4")) {
    if (pinned.family !== 4 || username.includes("\0") || password || Buffer.byteLength(username) > 255) throw new Error("Invalid media SOCKS4 route");
    const header = Buffer.alloc(8); header[0] = 4; header[1] = 1; header.writeUInt16BE(port, 2);
    pinned.address.split(".").forEach((part, i) => { header[4 + i] = Number(part); });
    socket.write(Buffer.concat([header, Buffer.from(username), Buffer.from([0])]));
    const reply = await readBytes(socket, 8);
    if (reply[0] !== 0 || reply[1] !== 90) throw new Error("Media SOCKS4 connect refused");
  } else {
    const authority = `${pinned.family === 6 ? `[${pinned.address}]` : pinned.address}:${port}`;
    const auth = username || password ? `Proxy-Authorization: Basic ${Buffer.from(`${username}:${password}`).toString("base64")}\r\n` : "";
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
    let response = "";
    while (!response.endsWith("\r\n\r\n")) {
      if (response.length >= 16384) throw new Error("Media proxy headers too large");
      response += (await readBytes(socket, 1)).toString("latin1");
    }
    if (!/^HTTP\/1\.[01] 200(?: |\r)/.test(response)) throw new Error("Media HTTP proxy connect refused");
  }
  return socket;
}

async function createMediaBroker(options                     = {})                       {
  options.signal?.throwIfAborted();
  const safeLookup = makeSafeLookup(options.lookup || dns.promises.lookup);
  const secret = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Basic ${Buffer.from(`media:${secret}`).toString("base64")}`);
  const route = options.proxy ? new URL(options.proxy) : null;
  if (route && !/^(https?|socks4a?|socks5h?):$/.test(route.protocol)) throw new Error("Invalid media proxy route");
  const sockets = new Set     (), controllers = new Set                 ();
  let closed = false, closing                       = null;
  const own = (socket     ) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    if (closed) socket.destroy();
    return socket;
  };
  function authenticated(req     )          {
    const actual = Buffer.from(String(req.headers["proxy-authorization"] || ""));
    return !closed && actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  async function open(host        , port        , signal             )               {
    target(host, port);
    const pinned = await new Promise                                     ((resolve, reject) => {
      safeLookup(host, { family: route?.protocol.startsWith("socks4") ? 4 : 0 },
        (error              , address        , family        ) => error ? reject(error) : resolve({ address, family }));
    });
    signal.throwIfAborted();
    if (closed) throw new Error("Media broker closed");
    return route ? throughProxy(route, pinned, port, own, signal)
      : connected(own(net.connect({ host: pinned.address, port, signal })));
  }
  function lifetime(client     ) {
    if (closed || controllers.size >= MAX_CONNECTIONS) throw new Error("Media job connection cap");
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort(); client.once("close", abort);
    const timer = setTimeout(abort, CONNECT_MS);
    return {
      signal: controller.signal,
      ready() { clearTimeout(timer); },
      end() { clearTimeout(timer); controller.abort(); controllers.delete(controller); client.removeListener("close", abort); },
    };
  }
  const server = http.createServer({ maxHeaderSize: 16384 }, async (req     , res     ) => {
    if (!authenticated(req)) { res.writeHead(407, { "proxy-authenticate": 'Basic realm="media"' }).end(); return; }
    let life                                         , upstream     ;
    try {
      const url = new URL(req.url);
      if (url.protocol !== "http:" || url.username || url.password || url.hash) throw new Error("Invalid proxy URL");
      life = lifetime(req.socket);
      upstream = await open(url.hostname.replace(/^\[|\]$/g, ""), Number(url.port || 80), life.signal);
      life.ready(); upstream.setTimeout(IDLE_MS, () => upstream.destroy());
      const headers = { ...req.headers, host: url.host };
      for (const key of String(headers.connection || "").split(",")) delete headers[key.trim().toLowerCase()];
      for (const key of ["proxy-authorization", "proxy-connection", "connection", "keep-alive", "upgrade", "te", "trailer"]) delete headers[key];
      const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => upstream;
      const forward = http.request(url, { method: req.method, headers, agent, signal: life.signal }, (response     ) => {
        const headers = { ...response.headers };
        for (const key of String(headers.connection || "").split(",")) delete headers[key.trim().toLowerCase()];
        for (const key of ["connection", "keep-alive", "proxy-authenticate", "upgrade", "te", "trailer", "transfer-encoding"]) delete headers[key];
        res.writeHead(response.statusCode, headers); response.pipe(res);
        response.once("error", () => res.destroy());
      });
      const done = () => { upstream.destroy(); agent.destroy(); life?.end(); };
      res.once("close", done);
      forward.once("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
      req.pipe(forward);
    } catch {
      upstream?.destroy(); life?.end();
      if (!res.headersSent) res.writeHead(502).end(); else res.destroy();
    }
  });
  server.on("connect", async (req     , client     , head     ) => {
    if (!authenticated(req)) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="media"\r\n\r\n'); return; }
    let life                                         , upstream     ;
    try {
      const url = new URL(`http://${req.url}`), host = url.hostname.replace(/^\[|\]$/g, "");
      if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || (!url.port && !req.url.endsWith(":80"))) throw new Error("Invalid CONNECT authority");
      life = lifetime(client); upstream = await open(host, Number(url.port || 80), life.signal); life.ready();
      client.setTimeout(IDLE_MS, () => client.destroy()); upstream.setTimeout(IDLE_MS, () => upstream.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.once("close", () => { upstream.destroy(); life?.end(); });
      upstream.once("close", () => { if (!upstream.readableEnded) client.destroy(); });
      client.pipe(upstream).pipe(client); upstream.resume();
    } catch {
      upstream?.destroy(); life?.end(); client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }
  });
  const close = ()                => {
    if (closing) return closing;
    closed = true;
    options.signal?.removeEventListener("abort", abort);
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    closing = new Promise((resolve) => server.close(() => resolve()));
    return closing;
  };
  const abort = () => { void close(); };
  server.requestTimeout = 0; server.timeout = IDLE_MS;
  server.maxConnections = MAX_CONNECTIONS * 2;
  server.on("connection", own);
  server.on("clientError", (_error       , socket     ) => socket.destroy());
  server.on("error", abort);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    let abortStart                          ;
    await new Promise      ((resolve, reject) => {
      abortStart = () => reject(options.signal?.reason || new Error("Media broker aborted"));
      options.signal?.addEventListener("abort", abortStart, { once: true });
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    }).finally(() => { if (abortStart) options.signal?.removeEventListener("abort", abortStart); });
    options.signal?.throwIfAborted();
    const endpoint = new URL(`http://127.0.0.1:${server.address().port}`);
    endpoint.username = "media";
    endpoint.password = secret;
    return { url: endpoint.href, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { createMediaBroker };
