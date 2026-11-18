const fs = require("node:fs");
const path = require("node:path");
const { runHostCommand } = require("../host-process.cjs");
const { createVideoResolver, setVideoProxy } = require("./video-source.cjs");

const ROUTE_RECORD_FILENAME = "ocuclaw.liveui-video-route.json";
const ROUTE_RECORD_SCHEMA = 1;
const EXEC_TIMEOUT_MS = 15000;

const TEST_VIDEO_PAGE = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const PHONE_OS = new Set(["android", "ios"]);
const EXIT_ROUTES = new Set(["0.0.0.0/0", "::/0"]);

function isRecord(v         )                           {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeAddress(value         )                {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "").toLowerCase();
}

function isTailnetAddress(address               )          {
  if (!address) return false;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(address);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return address.startsWith("fd7a:115c:a1e0:");
}

function isLoopback(address               )          {
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function peerIps(peer                     )           {
  const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : [];
  return ips.filter((ip         ) => typeof ip === "string").map((ip        ) => ip.toLowerCase());
}

function peerIpv4(peer                     )                {
  return peerIps(peer).find((ip) => ip.includes(".")) || peerIps(peer)[0] || null;
}

function peerName(peer                     )                {
  if (typeof peer.HostName === "string" && peer.HostName) return peer.HostName;
  if (typeof peer.DNSName === "string" && peer.DNSName) return peer.DNSName.split(".")[0] || null;
  return null;
}

function stripPrefix(addr         )                {
  return typeof addr === "string" ? addr.split("/")[0].toLowerCase() : null;
}

function socksProxyUrl(socks5                                )         {
  const host = socks5.host.includes(":") ? `[${socks5.host}]` : socks5.host;
  return `socks5://${host}:${socks5.port}`;
}

function createPhoneExitNode(deps                   ) {
  const available = Array.isArray(deps.cliArgv) && deps.cliArgv.length > 0 && deps.socks5 !== null;
  const proxyUrl = deps.socks5 ? socksProxyUrl(deps.socks5) : null;
  let proxyActive = false;
  let busy                   = Promise.resolve();

  function setProxy(on         )       {
    proxyActive = on;
    deps.setProxy(on ? proxyUrl : null);
  }

  async function tailscale(args          )                      {
    try {
      return await deps.exec([...(deps.cliArgv            ), ...args]);
    } catch (err     ) {
      return { code: null, stdout: "", stderr: String((err && err.message) || err) };
    }
  }

  async function json(args          )                                      {
    const r = await tailscale(args);
    if (r.code !== 0) return null;
    try {
      const doc = JSON.parse(r.stdout);
      return isRecord(doc) ? doc : null;
    } catch {
      return null;
    }
  }

  function peers(status                     )                        {
    return isRecord(status.Peer) ? Object.values(status.Peer).filter(isRecord) : [];
  }

  async function findPhone(status                     , remote                     )                                      {
    const all = peers(status);
    const address = normalizeAddress(remote && remote.address);
    if (isTailnetAddress(address)) {
      return all.find((p) => peerIps(p).includes(address          )) || null;
    }
    if (isLoopback(address) && remote && Number.isInteger(remote.port)) {
      const host = address === "::1" ? "[::1]" : "127.0.0.1";
      const who = await json(["whois", "--json", `${host}:${remote.port}`]);
      const node = who && isRecord(who.Node) ? who.Node : null;
      const addrs = node && Array.isArray(node.Addresses) ? node.Addresses.map(stripPrefix).filter(Boolean) : [];
      const hit = addrs.length ? all.find((p) => peerIps(p).some((ip) => addrs.includes(ip))) : null;
      if (hit) return hit;
    }
    const phones = all.filter((p) => p.Online === true && PHONE_OS.has(String(p.OS || "").trim().toLowerCase()));
    return phones.length === 1 ? phones[0] : null;
  }

  async function advertisesExitNode(peer                     )                   {
    const ip = peerIpv4(peer);
    if (!ip) return false;
    const who = await json(["whois", "--json", ip]);
    const hostinfo = who && isRecord(who.Node) && isRecord(who.Node.Hostinfo) ? who.Node.Hostinfo : null;
    const routes = hostinfo && Array.isArray(hostinfo.RoutableIPs) ? hostinfo.RoutableIPs : [];
    return routes.some((r         ) => typeof r === "string" && EXIT_ROUTES.has(r));
  }

  async function read(remote                     )                                                                              {
    if (!available) return { snapshot: { state: "no_tailscale_here", phone: null, detail: null }, peer: null };
    const status = await json(["status", "--json"]);
    if (!status || status.BackendState !== "Running") {
      return { snapshot: { state: "no_tailscale_here", phone: null, detail: "Tailscale on the host is not running" }, peer: null };
    }
    const peer = await findPhone(status, remote);
    if (!peer) return { snapshot: { state: "phone_not_on_tailnet", phone: null, detail: null }, peer: null };
    const name = peerName(peer);
    let state                 ;
    if (peer.ExitNode === true && proxyActive) state = "on";
    else if (peer.ExitNodeOption === true) state = "ready";
    else state = (await advertisesExitNode(peer)) ? "not_approved" : "not_offered";
    return { snapshot: { state, phone: name, detail: null }, peer };
  }

  function serial   (fn                  )             {
    const run = busy.then(fn, fn);
    busy = run.catch(() => undefined);
    return run;
  }

  async function clearExitNode()                         {
    const r = await tailscale(["set", "--exit-node="]);
    return r.code === 0 ? null : (r.stderr.trim() || `exit ${r.code}`).slice(0, 200);
  }

  return {
    get(remote                     )                              {
      return serial(async () => (await read(remote)).snapshot);
    },

    enable(remote                     )                              {
      return serial(async () => {
        const { snapshot, peer } = await read(remote);
        if (snapshot.state !== "ready" || !peer) return snapshot;
        const ip = peerIpv4(peer)          ;
        const set = await tailscale(["set", `--exit-node=${ip}`]);
        if (set.code !== 0) {
          return { ...snapshot, detail: (set.stderr.trim() || `exit ${set.code}`).slice(0, 200) };
        }
        const test = await deps.testRead(proxyUrl          );
        if (!test.ok) {
          await clearExitNode();
          return { ...snapshot, detail: `Test read failed: ${(test.error || "no answer").slice(0, 160)}` };
        }
        setProxy(true);
        deps.store.write({ enabled: true, peerIp: ip, peerName: snapshot.phone });
        return { ...snapshot, state: "on" };
      });
    },

    disable(remote                     )                              {
      return serial(async () => {
        const record = deps.store.read();
        setProxy(false);
        deps.store.write(null);

        const failed = available && record && record.enabled ? await clearExitNode() : null;
        const { snapshot } = await read(remote);
        return failed ? { ...snapshot, detail: failed } : snapshot;
      });
    },

    restore()                   {
      return serial(async () => {
        const record = deps.store.read();
        if (!available || !record || !record.enabled) return false;
        const status = await json(["status", "--json"]);
        const exit = status && isRecord(status.ExitNodeStatus) ? status.ExitNodeStatus : null;
        const ips = exit && Array.isArray(exit.TailscaleIPs) ? exit.TailscaleIPs.map(stripPrefix) : [];
        if (!ips.includes(record.peerIp.toLowerCase())) return false;
        setProxy(true);
        return true;
      });
    },
  };
}

async function defaultExec(argv          )                      {
  const r = await runHostCommand(argv, { timeoutMs: EXEC_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

function fileStore(hostStateDir               , writeJsonReceiptDurable                                              )                             {
  const file = hostStateDir ? path.join(hostStateDir, ROUTE_RECORD_FILENAME) : null;
  return {
    read() {
      if (!file) return null;
      try {
        const doc = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!isRecord(doc) || doc.schemaVersion !== ROUTE_RECORD_SCHEMA || typeof doc.peerIp !== "string") return null;
        return { enabled: doc.enabled === true, peerIp: doc.peerIp, peerName: typeof doc.peerName === "string" ? doc.peerName : null };
      } catch {
        return null;
      }
    },
    write(record) {
      if (!file) return;
      try {
        if (!record) {
          fs.rmSync(file, { force: true });
          return;
        }
        writeJsonReceiptDurable(file, { schemaVersion: ROUTE_RECORD_SCHEMA, ...record, updatedAt: new Date().toISOString() });
      } catch {

      }
    },
  };
}

function createDefaultPhoneExitNode(host                   , overrides                             = {})                {
  const hostStateDir = host.hostStateDir;
  const receipt      = host.readTailscaleCliReceipt(hostStateDir);
  return createPhoneExitNode({
    cliArgv: receipt ? receipt.argv : null,
    socks5: receipt && receipt.socks5 ? receipt.socks5 : null,
    exec: defaultExec,
    setProxy: (proxy) => setVideoProxy(proxy === null ? undefined : proxy),
    testRead: async (proxy) => {
      const resolved = await createVideoResolver({ proxy }).resolve(TEST_VIDEO_PAGE);
      return resolved.ok ? { ok: true } : { ok: false, error: resolved.error };
    },
    store: fileStore(hostStateDir, host.writeJsonReceiptDurable),
    ...overrides,
  });
}

module.exports = { ROUTE_RECORD_FILENAME, TEST_VIDEO_PAGE, normalizeAddress, isTailnetAddress, socksProxyUrl, createPhoneExitNode, createDefaultPhoneExitNode };
