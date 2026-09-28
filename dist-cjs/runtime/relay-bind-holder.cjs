const net = require("node:net");
const { execFile } = require("node:child_process");
const fs = require("node:fs");

const RELAY_BIND_HOLDER_RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 6000, 8000]);

const CONNECT_PROBE_TIMEOUT_MS = 750;
const SS_TIMEOUT_MS = 2000;
const UNKNOWN_OWNER = "unknown";

function parseSsPortHolders(ssOutput, port) {
  const suffix = `:${port}`;
  const rows = [];
  for (const line of String(ssOutput || "").split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const state = columns[0];
    const local = columns[3];
    if (!String(local).endsWith(suffix)) continue;
    const users = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    rows.push({
      state,
      local,
      process: users ? users[1] : null,
      pid: users ? Number(users[2]) : null,
    });
  }
  return rows;
}

function describeRow(row) {
  const who = row.process ? `${row.process} pid ${row.pid}` : "unknown process";
  return `${who} (${row.state} ${row.local})`;
}

function describeSsPortHolders(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return UNKNOWN_OWNER;
  const listen = list.find((row) => row && row.state === "LISTEN");
  const head = listen || list[0];
  const extra = list.length - 1;
  return extra > 0 ? `${describeRow(head)} +${extra} more` : describeRow(head);
}

function probeHostForBindHost(host) {
  const value = typeof host === "string" ? host.trim() : "";
  if (!value || value === "0.0.0.0") return "127.0.0.1";
  if (value === "::" || value === "[::]") return "::1";
  return value.replace(/^\[(.*)\]$/, "$1");
}

function probeRelayPortListener(options = {}) {
  const connect = typeof options.connect === "function" ? options.connect : net.connect;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : CONNECT_PROBE_TIMEOUT_MS;
  const host = probeHostForBindHost(options.host);
  const port = options.port;
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { if (socket) socket.destroy(); } catch (_) {  }
      resolve(verdict);
    };
    try {
      socket = connect({ host, port });
    } catch (_) {
      settle("unknown");
      return;
    }
    socket.once("connect", () => settle("listening"));
    socket.once("error", (err) => {
      settle(err && err.code === "ECONNREFUSED" ? "not_listening" : "unknown");
    });
    timer = setTimeout(() => settle("unknown"), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  });
}

function readSsPortHolders(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return Promise.resolve(null);
  const run = typeof options.execFile === "function" ? options.execFile : execFile;
  const port = options.port;
  return new Promise((resolve) => {
    try {
      run(
        "ss",
        ["-tanp", `sport = :${port}`],
        { timeout: SS_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(null);
            return;
          }
          resolve(parseSsPortHolders(stdout, port));
        },
      );
    } catch (_) {
      resolve(null);
    }
  });
}

const PROC_NET_TCP_STATES = Object.freeze({
  "01": "ESTAB",
  "02": "SYN-SENT",
  "03": "SYN-RECV",
  "04": "FIN-WAIT-1",
  "05": "FIN-WAIT-2",
  "06": "TIME-WAIT",
  "07": "UNCONN",
  "08": "CLOSE-WAIT",
  "09": "LAST-ACK",
  "0A": "LISTEN",
  "0B": "CLOSING",
});

function procNetLocalAddress(hexAddress) {
  const value = String(hexAddress || "");
  const bytes = [];
  for (let i = 0; i + 1 < value.length; i += 2) bytes.push(parseInt(value.slice(i, i + 2), 16));
  if (bytes.length === 4) return bytes.reverse().join(".");

  if (bytes.length === 16) {
    const words = [];
    for (let w = 0; w < 4; w += 1) words.push(bytes.slice(w * 4, w * 4 + 4).reverse());
    const flat = words.flat();
    const mapped = flat.slice(0, 10).every((b) => b === 0) && flat[10] === 255 && flat[11] === 255;
    if (mapped) return flat.slice(12).join(".");
    return `[${flat.map((b) => b.toString(16).padStart(2, "0")).join("")}]`;
  }
  return value;
}

function parseProcNetTcpHolders(tableText, port) {
  const wantPort = Number(port);
  const rows = [];
  for (const line of String(tableText || "").split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 4 || !/^\d+:$/.test(columns[0])) continue;
    const [addrHex, portHex] = String(columns[1]).split(":");
    if (!portHex || parseInt(portHex, 16) !== wantPort) continue;
    const stateHex = String(columns[3]).toUpperCase();
    rows.push({
      state: PROC_NET_TCP_STATES[stateHex] || `STATE-${stateHex}`,
      local: `${procNetLocalAddress(addrHex)}:${wantPort}`,
      process: null,
      pid: null,
    });
  }
  return rows;
}

function readProcNetPortHolders(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "linux") return Promise.resolve(null);
  const readFile = typeof options.readFile === "function" ? options.readFile : fs.promises.readFile;
  const tables = ["/proc/net/tcp", "/proc/net/tcp6"];
  return Promise.all(
    tables.map((table) => Promise.resolve()
      .then(() => readFile(table, "utf8"))
      .then((text) => parseProcNetTcpHolders(text, options.port))
      .catch(() => null)),
  ).then((results) => {
    if (results.every((rows) => rows === null)) return null;
    return results.flatMap((rows) => rows || []);
  });
}

async function readPortHolders(options = {}) {
  const readSs = typeof options.readSs === "function" ? options.readSs : readSsPortHolders;
  const readProc = typeof options.readProc === "function" ? options.readProc : readProcNetPortHolders;
  const fromSs = await readSs({ port: options.port }).catch(() => null);
  if (Array.isArray(fromSs)) return fromSs;
  return readProc({ port: options.port }).catch(() => null);
}

async function describeRelayPortHolder(options = {}) {
  const probe = typeof options.probeListener === "function"
    ? options.probeListener
    : probeRelayPortListener;
  const readRows = typeof options.readHolders === "function"
    ? options.readHolders
    : readPortHolders;
  let verdict = "unknown";
  try {
    verdict = await probe({ host: options.host, port: options.port });
  } catch (_) {
    verdict = "unknown";
  }
  let rows = null;
  try {
    rows = await readRows({ port: options.port });
  } catch (_) {
    rows = null;
  }
  const list = Array.isArray(rows) ? rows : [];
  const listening = verdict === "listening" || list.some((row) => row && row.state === "LISTEN");
  return {
    listening,
    owner: describeSsPortHolders(list),
    probe: verdict,
    rows: list,
  };
}

function relayPortLabel(host, port) {
  return `relay port ${port} on ${host || "127.0.0.1"}`;
}

const FIX_HINT = "Stop that process or set the relay port (wsPort) to a free port.";

function formatRelayPortListenerMessage(options = {}) {
  return `${relayPortLabel(options.host, options.port)} is in use (EADDRINUSE) by a listening process: ${options.owner || UNKNOWN_OWNER}. ${FIX_HINT}`;
}

function formatRelayPortHeldRetryMessage(options = {}) {
  const seconds = Math.round((Number(options.delayMs) || 0) / 100) / 10;
  return `${relayPortLabel(options.host, options.port)} is held (EADDRINUSE) by ${options.owner || UNKNOWN_OWNER} with nothing listening (an outbound connection took it as its ephemeral port, #3749); bind retry ${options.attempt}/${options.maxAttempts} in ${seconds}s`;
}

function formatRelayPortHeldExhaustedMessage(options = {}) {
  const seconds = Math.round((Number(options.elapsedMs) || 0) / 1000);
  return `${relayPortLabel(options.host, options.port)} is still held (EADDRINUSE) by ${options.owner || UNKNOWN_OWNER} after ${options.attempts} bind retries over ${seconds}s, with nothing listening (an outbound connection holds it as its ephemeral port, #3749). Close that connection or set the relay port (wsPort) to a free port.`;
}

function createRelayBindConflictError(message, conflict) {
  return Object.assign(new Error(message), {
    code: "EADDRINUSE",
    bindConflict: conflict,
  });
}

module.exports = { RELAY_BIND_HOLDER_RETRY_DELAYS_MS, parseSsPortHolders, describeSsPortHolders, probeHostForBindHost, probeRelayPortListener, readSsPortHolders, parseProcNetTcpHolders, readProcNetPortHolders, readPortHolders, describeRelayPortHolder, formatRelayPortListenerMessage, formatRelayPortHeldRetryMessage, formatRelayPortHeldExhaustedMessage, createRelayBindConflictError };
