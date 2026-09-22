const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { dialTailnet, parseSocks5 } = require("./tailnet-dial.cjs");

const OPENCLAW_SERVE_PORT = 8444;
const LOOPBACK = "127.0.0.1";
const SERVE_PROTOCOL_TLS_TERMINATED_TCP = "tls-terminated-tcp";
const RUNTIME_BUNDLE_OPENCLAW = "openclaw";

const OPENCLAW_ROUTE_RECEIPT_FILENAME = "ocuclaw.managed-serve-route.openclaw.json";
const OPENCLAW_ROUTE_RECEIPT_LOCK_FILENAME = "ocuclaw.managed-serve-route.openclaw.lock";
const HERMES_ROUTE_RECEIPT_FILENAME = "ocuclaw.managed-serve-route.json";
const ROUTE_RECEIPT_SCHEMA_VERSION = 1;

const TAILSCALE_CLI_RECEIPT_FILENAME = "ocuclaw.tailscale-cli.json";
const TAILSCALE_CLI_SCHEMA_VERSION = 1;
const DEFAULT_TAILSCALE_ARGV = ["tailscale"];

const OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED = "proposed-then-observed";
const OWNERSHIP_BASIS_OBSERVED_SHAPE_MATCH = "observed-shape-match";

const CLASSIFY_READY = "ready";
const CLASSIFY_ABSENT = "absent";
const CLASSIFY_WRONG = "wrong";
const CLASSIFY_UNKNOWN = "unknown";

const REASON_MATCHES = "route_matches";
const REASON_NO_ROUTE_AT_PORT = "no_route_at_port";
const REASON_HTTPS_NOT_TCP = "https_route_not_tls_terminated_tcp";
const REASON_HTTP_NOT_TCP = "http_route_not_tls_terminated_tcp";
const REASON_RAW_TCP_NOT_TLS = "raw_tcp_route_without_tls_termination";
const REASON_PROXY_PROTOCOL = "route_uses_proxy_protocol";
const REASON_FOREIGN_TARGET = "forwards_to_a_different_target";
const REASON_FOREIGN_TLS_IDENTITY = "terminates_tls_for_another_node";
const REASON_WEB_HANDLER_AT_PORT = "web_handler_occupies_the_port";
const REASON_FUNNEL_ENABLED = "route_is_exposed_by_funnel";
const REASON_FOREGROUND_SESSION = "foreground_serve_session_active";
const REASON_UNRECOGNISED_DOCUMENT = "unrecognised_serve_document";
const REASON_UNRECOGNISED_ENTRY = "unrecognised_route_entry";
const REASON_NO_DNS_IDENTITY = "node_dns_identity_unknown";
const REASON_NO_RELAY_PORT = "relay_port_unknown";
const REASON_NOT_READ = "serve_status_not_read";
const REASON_NETWORK_OFFLINE = "private_network_offline";

const READ_OK = "serve_read_ok";
const READ_CLI_ABSENT = "serve_cli_absent";
const READ_TIMEOUT = "serve_read_timeout";
const READ_FAILED = "serve_read_failed";
const READ_UNPARSABLE = "serve_read_unparsable";

const WEB_OCCUPIED_REASONS = new Set([
  REASON_HTTPS_NOT_TCP,
  REASON_HTTP_NOT_TCP,
  REASON_WEB_HANDLER_AT_PORT,
]);

const RECORD_WRITTEN = "route_receipt_written";
const RECORD_PROPOSED = "route_proposal_recorded";
const RECORD_FOREIGN_OWNER = "route_receipt_owned_by_another_gateway";
const RECORD_FOREIGN_HERMES = "route_receipt_owned_by_hermes_bundle";
const RECORD_UNREADABLE_HERMES = "hermes_route_receipt_present_but_unreadable";
const RECORD_UNREADABLE_CLAIM = "route_receipt_present_but_unreadable";
const RECORD_NOT_OWNED = "route_receipt_not_written_route_not_ready";
const RECORD_INCOMPLETE = "route_receipt_not_written_route_not_fully_identified";
const RECORD_UNAVAILABLE = "route_receipt_unavailable";
const RECORD_NOT_ATTEMPTED = "route_receipt_not_attempted";

const ROUTE_STATUS_HEALTHY = "healthy";
const ROUTE_STATUS_MISSING = "missing";
const ROUTE_STATUS_STALE = "stale";
const ROUTE_STATUS_FOREIGN = "foreign";
const ROUTE_STATUS_CONFLICTING = "conflicting";
const ROUTE_STATUS_EXPOSED = "exposed";
const ROUTE_STATUS_UNREACHABLE = "unreachable";
const ROUTE_STATUS_OFFLINE = "offline";
const ROUTE_STATUS_UNKNOWN = "unknown";

const READ_TIMEOUT_MS = 2000;
const TARGET_PROBE_TIMEOUT_MS = 1500;
const FRONT_DOOR_PROBE_TIMEOUT_MS = 2500;
const LOCK_WAIT_MS = 5000;

const KNOWN_TCP_FIELDS = new Set(["HTTPS", "HTTP", "TCPForward", "TerminateTLS", "ProxyProtocol"]);
const KNOWN_TOP_LEVEL_KEYS = new Set(["TCP", "Web", "AllowFunnel", "ETag", "Services"]);
const FOREGROUND_KEY = "Foreground";
const DNS_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedPort(value     ) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function servePort(configured      = null) {
  return boundedPort(configured) ? configured : OPENCLAW_SERVE_PORT;
}

function normalizeDnsName(value     ) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\.+$/, "");
  if (!name || !DNS_NAME_RE.test(name)) return null;
  return name;
}

function fingerprintNodeIdentity(dnsName     ) {
  const name = normalizeDnsName(dnsName);
  if (!name) return null;
  return createHash("sha256").update(name, "utf8").digest("hex");
}

function shellWord(value     ) {
  const text = String(value);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

function tailscaleCommandPrefix(cliArgv      = null) {
  const argv = Array.isArray(cliArgv) && cliArgv.length > 0 ? cliArgv : DEFAULT_TAILSCALE_ARGV;
  return argv.map(shellWord).join(" ");
}

function applyCommand(relayPort     , port      = null, cliArgv      = null) {
  return `${tailscaleCommandPrefix(cliArgv)} serve --bg --tls-terminated-tcp=${servePort(port)} tcp://${LOOPBACK}:${relayPort}`;
}

function teardownCommand(port      = null, cliArgv      = null) {

  return `${tailscaleCommandPrefix(cliArgv)} serve --tls-terminated-tcp=${servePort(port)} off`;
}

function defaultRunTailscale(args     , cliArgv      = null) {
  const argv = Array.isArray(cliArgv) && cliArgv.length > 0 ? cliArgv : DEFAULT_TAILSCALE_ARGV;
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1).concat(args),
      { timeout: READ_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: "utf8" },
      (error     , stdout     ) => {
        if (error) {
          if (error.code === "ENOENT") { resolve({ code: READ_CLI_ABSENT, stdout: "" }); return; }
          if (error.killed || error.signal === "SIGTERM") { resolve({ code: READ_TIMEOUT, stdout: "" }); return; }
          resolve({ code: READ_FAILED, stdout: typeof stdout === "string" ? stdout : "" });
          return;
        }
        resolve({ code: READ_OK, stdout: typeof stdout === "string" ? stdout : "" });
      },
    );
  });
}

async function runJson(run     , args     ) {
  let result     ;
  try {
    result = await run(args);
  } catch (_) {
    return { document: null, code: READ_FAILED };
  }
  const code = result && typeof result.code === "string" ? result.code : READ_FAILED;
  if (code !== READ_OK) return { document: null, code };
  const raw = result.stdout;
  if (typeof raw !== "string" || !raw.trim()) return { document: null, code: READ_UNPARSABLE };
  try {
    const document = JSON.parse(raw);
    if (!isRecord(document)) return { document: null, code: READ_UNPARSABLE };
    return { document, code: READ_OK };
  } catch (_) {
    return { document: null, code: READ_UNPARSABLE };
  }
}

async function readServeStatus(run     ) {
  return runJson(run, ["serve", "status", "--json"]);
}

async function readNodeState(run     ) {
  const { document, code } = await runJson(run, ["status", "--json"]);
  if (!document) return { dnsName: null, network: "unknown", code };
  const backend = document.BackendState;
  const self = isRecord(document.Self) ? document.Self : null;
  if (typeof backend !== "string" || !self || typeof self.Online !== "boolean") {
    return { dnsName: null, network: "unknown", code: READ_UNPARSABLE };
  }
  if (!["Running", "Stopped", "NeedsLogin", "NeedsMachineAuth", "Starting", "NoState"].includes(backend)) {
    return { dnsName: null, network: "unknown", code: READ_UNPARSABLE };
  }
  const dnsName = normalizeDnsName(self.DNSName);
  const online = backend === "Running" && self.Online === true;
  return { dnsName, network: online ? "online" : "offline", code: dnsName ? READ_OK : READ_UNPARSABLE };
}

const PHONE_OPERATING_SYSTEMS = ["ios", "android"];

async function readPhonePresence(run     ) {
  const { document, code } = await runJson(run, ["status", "--json"]);
  if (!document || typeof document.BackendState !== "string") {
    return { found: false, readable: false, code: document ? READ_UNPARSABLE : code };
  }
  const peers = isRecord(document.Peer) ? document.Peer : {};
  for (const key of Object.keys(peers)) {
    const peer = peers[key];
    if (!isRecord(peer) || peer.Online !== true) continue;
    const operatingSystem = typeof peer.OS === "string" ? peer.OS.trim().toLowerCase() : "";
    if (PHONE_OPERATING_SYSTEMS.includes(operatingSystem)) {
      return { found: true, readable: true, code: READ_OK };
    }
  }
  return { found: false, readable: true, code: READ_OK };
}

function tcpTable(document     ) {
  if (!Object.prototype.hasOwnProperty.call(document, "TCP")) return {};
  const tcp = document.TCP;
  if (!isRecord(tcp)) return null;
  return tcp;
}

function portOf(key     ) {
  return typeof key === "string" ? key.split(":").pop() : null;
}

function funnelExposed(document     , hostPort     , dnsName     ) {
  const funnel = document.AllowFunnel;
  if (!isRecord(funnel)) return false;
  if (funnel[hostPort] === true) return true;
  if (dnsName && funnel[`${dnsName}:${hostPort}`] === true) return true;
  return Object.entries(funnel).some(([key, value]) => portOf(key) === hostPort && value === true);
}

function webHandlerOnPort(document     , hostPort     ) {
  const web = document.Web;
  if (!isRecord(web)) return false;
  return Object.keys(web).some((key) => portOf(key) === hostPort);
}

function foregroundVerdict(document     , hostPort     ) {
  if (!Object.prototype.hasOwnProperty.call(document, FOREGROUND_KEY)) return null;
  const foreground = document[FOREGROUND_KEY];
  if (!isRecord(foreground)) return REASON_UNRECOGNISED_DOCUMENT;
  for (const session of Object.values(foreground)) {
    if (!isRecord(session)) return REASON_UNRECOGNISED_DOCUMENT;
    const sessionAny      = session;
    if (sessionAny.TCP !== undefined && sessionAny.TCP !== null) {
      if (!isRecord(sessionAny.TCP)) return REASON_UNRECOGNISED_DOCUMENT;
      if (Object.prototype.hasOwnProperty.call(sessionAny.TCP, hostPort)) return REASON_FOREGROUND_SESSION;
    }
    if (sessionAny.Web !== undefined && sessionAny.Web !== null) {
      if (!isRecord(sessionAny.Web)) return REASON_UNRECOGNISED_DOCUMENT;
      if (Object.keys(sessionAny.Web).some((key) => portOf(key) === hostPort)) return REASON_FOREGROUND_SESSION;
    }
    if (sessionAny.AllowFunnel !== undefined && sessionAny.AllowFunnel !== null) {
      if (!isRecord(sessionAny.AllowFunnel)) return REASON_UNRECOGNISED_DOCUMENT;
      if (Object.entries(sessionAny.AllowFunnel).some(([key, value]) => portOf(key) === hostPort && value === true)) {
        return REASON_FUNNEL_ENABLED;
      }
    }
  }
  return null;
}

function classifyServeDocument(document     , options      = {}) {
  const port = servePort(options.port);
  const hostPort = String(port);
  const dnsName = normalizeDnsName(options.dnsName);
  const relayPort = boundedPort(options.relayPort) ? options.relayPort : null;
  const observed = (classification     , configured     , reason     , extra      = {}) => ({
    classification, configured, reason, port, relayPort, forward: null, terminate: null, ...extra,
  });

  if (!isRecord(document)) return observed(CLASSIFY_UNKNOWN, "unknown", REASON_NOT_READ);
  for (const key of Object.keys(document)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key) && key !== FOREGROUND_KEY) {
      return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_DOCUMENT);
    }
  }
  if (Object.prototype.hasOwnProperty.call(document, "Services") && !isRecord(document.Services)) {
    return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_DOCUMENT);
  }
  if (Object.prototype.hasOwnProperty.call(document, "AllowFunnel") && !isRecord(document.AllowFunnel)) {
    return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_DOCUMENT);
  }
  const foreground = foregroundVerdict(document, hostPort);
  if (foreground === REASON_FUNNEL_ENABLED) return observed(CLASSIFY_WRONG, "yes", REASON_FUNNEL_ENABLED);
  if (foreground) return observed(CLASSIFY_UNKNOWN, "unknown", foreground);

  const tcp = tcpTable(document);
  if (!tcp || (Object.prototype.hasOwnProperty.call(document, "Web") && !isRecord(document.Web))) {
    return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_DOCUMENT);
  }
  const webOnPort = webHandlerOnPort(document, hostPort);

  if (funnelExposed(document, hostPort, dnsName)) return observed(CLASSIFY_WRONG, "yes", REASON_FUNNEL_ENABLED);
  if (Object.prototype.hasOwnProperty.call(tcp, hostPort) && !isRecord(tcp[hostPort])) {
    return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_ENTRY);
  }
  const entry = tcp[hostPort];
  if (entry === undefined) {
    if (webOnPort) return observed(CLASSIFY_WRONG, "yes", REASON_WEB_HANDLER_AT_PORT);
    return observed(CLASSIFY_ABSENT, "no", REASON_NO_ROUTE_AT_PORT);
  }
  const fields = Object.keys(entry);
  if (fields.some((field) => !KNOWN_TCP_FIELDS.has(field))) {
    return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_ENTRY);
  }
  const webFields = fields.filter((field) => field === "HTTPS" || field === "HTTP");
  const forwardFields = fields.filter((field) => field === "TCPForward" || field === "TerminateTLS" || field === "ProxyProtocol");
  if (webFields.length > 0 && forwardFields.length > 0) {
    return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_ENTRY);
  }
  if (webFields.length > 0) {
    if (fields.length === 1 && fields[0] === "HTTPS" && entry.HTTPS === true) return observed(CLASSIFY_WRONG, "yes", REASON_HTTPS_NOT_TCP);
    if (fields.length === 1 && fields[0] === "HTTP" && entry.HTTP === true) return observed(CLASSIFY_WRONG, "yes", REASON_HTTP_NOT_TCP);
    return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_ENTRY);
  }
  const forward = entry.TCPForward;
  const terminate = entry.TerminateTLS;
  if (typeof forward !== "string" || !forward) return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_ENTRY);
  const extra = { forward, terminate: typeof terminate === "string" ? normalizeDnsName(terminate) : null };
  if (webOnPort) return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_DOCUMENT, extra);
  if (terminate === undefined || terminate === null) return observed(CLASSIFY_WRONG, "yes", REASON_RAW_TCP_NOT_TLS, extra);
  if (typeof terminate !== "string" || !terminate) return observed(CLASSIFY_UNKNOWN, "unknown", REASON_UNRECOGNISED_ENTRY);
  if (entry.ProxyProtocol) return observed(CLASSIFY_WRONG, "yes", REASON_PROXY_PROTOCOL, extra);
  if (!dnsName) return observed(CLASSIFY_UNKNOWN, "yes", REASON_NO_DNS_IDENTITY, extra);
  if (normalizeDnsName(terminate) !== dnsName) return observed(CLASSIFY_WRONG, "yes", REASON_FOREIGN_TLS_IDENTITY, extra);
  if (relayPort === null) return observed(CLASSIFY_UNKNOWN, "yes", REASON_NO_RELAY_PORT, extra);
  if (forward !== `${LOOPBACK}:${relayPort}`) return observed(CLASSIFY_WRONG, "yes", REASON_FOREIGN_TARGET, extra);
  return observed(CLASSIFY_READY, "yes", REASON_MATCHES, extra);
}

function defaultProbeLoopbackTarget(port     ) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (verdict     ) => { if (settled) return; settled = true; try { socket.destroy(); } catch (_) {  } resolve(verdict); };
    const socket = net.connect({ host: LOOPBACK, port });
    socket.setTimeout(TARGET_PROBE_TIMEOUT_MS, () => settle("timeout"));
    socket.once("connect", () => settle("listening"));
    socket.once("error", (error     ) => settle(error && error.code === "ECONNREFUSED" ? "refused" : "failed"));
  });
}

function defaultProbeFrontDoor(dnsName     , port     , socks5      = null) {
  return new Promise((resolve) => {
    let settled = false;
    let socket      = null;
    let carrier      = null;
    const settle = (verdict     ) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.destroy(); } catch (_) {  }
      try { if (carrier) carrier.destroy(); } catch (_) {  }
      resolve(verdict);
    };
    const timer = setTimeout(() => settle("timeout"), FRONT_DOOR_PROBE_TIMEOUT_MS);
    const classify = (error     ) => {
      clearTimeout(timer);
      const code = error && typeof error.code === "string" ? error.code : "";
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") { settle("unresolved"); return; }
      if (code === "ETIMEDOUT") { settle("timeout"); return; }
      if (code === "ECONNREFUSED" || code === "ECONNRESET") { settle("refused"); return; }
      if (/CERT|TLS|SSL|HANDSHAKE|EPROTO/i.test(code) || /handshake|certificate/i.test(String(error && error.message))) { settle("tls-handshake-failed"); return; }
      settle("failed");
    };
    const handshake = (existing     ) => {
      const options      = { host: dnsName, port, servername: dnsName, rejectUnauthorized: true };
      if (existing) { options.socket = existing; delete options.host; delete options.port; }
      socket = tls.connect(options, () => {
        clearTimeout(timer);
        settle("accepted");
      });
      socket.once("error", classify);
    };
    const proxy = parseSocks5(socks5) || (socks5 && typeof socks5 === "object" ? socks5 : null);
    try {
      if (!proxy) { handshake(null); return; }
      dialTailnet({ host: dnsName, port, socks5: proxy, timeoutMs: FRONT_DOOR_PROBE_TIMEOUT_MS })
        .then((raw     ) => {
          if (settled) { try { raw.destroy(); } catch (_) {  } return; }
          carrier = raw;
          raw.once("error", classify);
          handshake(raw);
        })
        .catch(classify);
    } catch (_) {
      clearTimeout(timer);
      settle("failed");
    }
  });
}

function resolveHostStateDir(env      = process.env) {
  const environment = isRecord(env) ? env : {};
  if (process.platform === "win32") {
    const base = environment.LOCALAPPDATA;
    if (typeof base === "string" && base.trim()) return path.join(base, "evenclaw", "state");
  }
  let home = typeof environment.HOME === "string" && environment.HOME.trim() ? environment.HOME : "";
  if (!home) {
    try { home = os.homedir(); } catch (_) { home = ""; }
  }
  if (!home) return null;
  return path.join(home, ".evenclaw", "state");
}

function readJsonReceipt(filePath     ) {
  if (typeof filePath !== "string" || !filePath) return { record: null, status: "missing" };
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error     ) {
    return { record: null, status: error && error.code === "ENOENT" ? "missing" : "unreadable" };
  }
  try {
    const record = JSON.parse(raw);
    if (!isRecord(record)) return { record: null, status: "unreadable" };
    if (record.schemaVersion !== ROUTE_RECEIPT_SCHEMA_VERSION) return { record: null, status: "unsupported_schema" };
    return { record, status: "ok" };
  } catch (_) {
    return { record: null, status: "unreadable" };
  }
}

function readTailscaleCliReceipt(hostStateDir     ) {
  if (typeof hostStateDir !== "string" || !hostStateDir) return null;
  const { record, status } = readJsonReceipt(path.join(hostStateDir, TAILSCALE_CLI_RECEIPT_FILENAME));
  if (status !== "ok") return null;
  const raw = Array.isArray(record.argv) ? record.argv : null;
  if (!raw) return null;
  const argv = raw.filter((part     ) => typeof part === "string" && part.trim()).map((part     ) => String(part));
  if (argv.length === 0 || !path.isAbsolute(argv[0])) return null;
  return {
    argv,
    socks5: parseSocks5(record.socks5),
    provisioner: typeof record.provisioner === "string" ? record.provisioner : "unknown",
  };
}

function buildTailscaleCliBody(input      = {}) {
  const raw = Array.isArray(input.argv) ? input.argv : [];
  const argv = raw.filter((part     ) => typeof part === "string" && part.trim()).map((part     ) => String(part));
  if (argv.length === 0 || !path.isAbsolute(argv[0])) {
    throw new Error("tailscale CLI argv must start with an absolute binary path");
  }
  const socks5 = input.socks5 === undefined || input.socks5 === null ? null : input.socks5;
  if (socks5 !== null && !parseSocks5(socks5)) {
    throw new Error("socks5 must be a loopback host:port");
  }
  return {
    schemaVersion: TAILSCALE_CLI_SCHEMA_VERSION,
    argv,
    socks5,
    provisioner: String(input.provisioner || "unknown"),
    writtenAt: input.writtenAt || nowIso(),
  };
}

function hardenPath(target     , isDir     ) {
  if (process.platform === "win32") return;
  fs.chmodSync(target, isDir ? 0o700 : 0o600);
}

function fsyncDirectory(directory     ) {
  if (process.platform === "win32") return;
  let fd = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch (_) {

  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {  } }
  }
}

function writeTemp(directory     , filePath     , body     ) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  hardenPath(directory, true);
  const payload = JSON.stringify(sortKeys(body));
  const tmpPath = path.join(directory, `${path.basename(filePath)}.${process.pid}.${Date.now().toString(36)}.tmp`);
  const fd = fs.openSync(tmpPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  hardenPath(tmpPath, false);
  return tmpPath;
}

function sortKeys(value     ) {
  if (!isRecord(value)) return value;
  const out      = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

function writeJsonReceiptDurable(filePath     , body     ) {
  const directory = path.dirname(filePath);
  const tmpPath = writeTemp(directory, filePath, body);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch (_) {  }
    throw error;
  }
  fsyncDirectory(directory);
}

function claimJsonReceipt(filePath     , body     ) {
  const directory = path.dirname(filePath);
  const tmpPath = writeTemp(directory, filePath, body);
  try {
    if (process.platform === "win32") {
      fs.copyFileSync(tmpPath, filePath, fs.constants.COPYFILE_EXCL);
    } else {
      fs.linkSync(tmpPath, filePath);
    }
  } catch (error     ) {
    if (error && error.code === "EEXIST") {
      const claimed      = new Error("route receipt already claimed");
      claimed.code = "already_claimed";
      throw claimed;
    }
    throw error;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {  }
  }
  fsyncDirectory(directory);
}

async function withReceiptLock(directory     , fn     ) {
  const lockPath = path.join(directory, OPENCLAW_ROUTE_RECEIPT_LOCK_FILENAME);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  hardenPath(directory, true);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      acquired = true;
    } catch (error     ) {
      if (!error || error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) return { locked: false, value: undefined };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return { locked: true, value: await fn() };
  } finally {
    try { fs.unlinkSync(lockPath); } catch (_) {  }
  }
}

function nowIso() {
  return new Date().toISOString();
}

function buildRouteReceiptBody(input     ) {
  const stamp = input.observedAt || nowIso();
  const observedRoute = boundedPort(input.relayPort);
  return {
    schemaVersion: ROUTE_RECEIPT_SCHEMA_VERSION,
    runtimeBundle: RUNTIME_BUNDLE_OPENCLAW,
    updated_at: stamp,
    firstObservedAt: observedRoute ? (input.firstObservedAt || stamp) : null,
    servePort: servePort(input.servePort),
    protocol: SERVE_PROTOCOL_TLS_TERMINATED_TCP,
    observedTarget: observedRoute ? `${LOOPBACK}:${input.relayPort}` : null,

    previousObservedTarget: input.previousObservedTarget || null,
    nodeIdentityFingerprint: input.nodeIdentityFingerprint || null,
    owningGatewayFingerprint: input.owningGatewayFingerprint || null,
    configuredProfiles: [],
    proposedCommand: input.proposedCommand || null,
    teardownCommand: teardownCommand(input.servePort, input.cliArgv || null),
    proposedAt: input.proposedAt || null,
    ownershipBasis: input.proposedAt ? OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED : OWNERSHIP_BASIS_OBSERVED_SHAPE_MATCH,
  };
}

function routeReceiptAgrees(record     , live     ) {
  if (!isRecord(record)) return false;
  if (record.schemaVersion !== ROUTE_RECEIPT_SCHEMA_VERSION || record.runtimeBundle !== RUNTIME_BUNDLE_OPENCLAW) return false;
  if (!live.installationId || record.owningGatewayFingerprint !== live.installationId) return false;
  if (!boundedPort(live.relayPort) || !live.nodeIdentityFingerprint) return false;
  if (record.protocol !== SERVE_PROTOCOL_TLS_TERMINATED_TCP) return false;
  if (record.servePort !== servePort(live.servePort)) return false;
  if (record.observedTarget !== `${LOOPBACK}:${live.relayPort}`) return false;
  if (record.nodeIdentityFingerprint !== live.nodeIdentityFingerprint) return false;
  return true;
}

function carriedProposal(known     , expected     ) {
  if (!isRecord(known)) return null;
  const proposedAt = known.proposedAt;
  if (typeof proposedAt !== "string" || !proposedAt) return null;
  if (known.proposedCommand !== expected.command) return null;
  if (known.servePort !== expected.servePort) return null;
  if (!expected.fingerprint || known.nodeIdentityFingerprint !== expected.fingerprint) return null;
  if (known.owningGatewayFingerprint !== expected.owner) return null;
  return proposedAt;
}

function ownershipConflict(status     , known     , mine     , port     , fingerprint     ) {
  if (status === "missing") return null;
  if (status !== "ok") return RECORD_UNREADABLE_CLAIM;
  const owner = known.owningGatewayFingerprint;
  if (!owner) return RECORD_UNREADABLE_CLAIM;
  if (!mine || owner !== mine) return RECORD_FOREIGN_OWNER;
  if (known.runtimeBundle !== RUNTIME_BUNDLE_OPENCLAW || known.servePort !== port ||
      known.protocol !== SERVE_PROTOCOL_TLS_TERMINATED_TCP ||
      !fingerprint || known.nodeIdentityFingerprint !== fingerprint) return RECORD_UNREADABLE_CLAIM;
  return null;
}

function ownershipFromReceipts(ours     , hermes     , installationId     , port     , fingerprint     ) {

  const hermesRecord = hermes.status === "ok" ? hermes.record : null;
  const hermesServePort = hermesRecord && boundedPort(hermesRecord.servePort) ? hermesRecord.servePort : null;
  const coexistence = {
    hermesReceipt: hermes.status === "ok" ? "present" : hermes.status === "missing" ? "absent" : "unreadable",
    hermesServePort,
    collision: hermesServePort === port,
    evidence: "hermes-receipt-read-only",
  };
  if (hermes.status !== "missing" && (hermes.status !== "ok" || hermesServePort === null)) {
    return { status: "unreadable-claim", basis: null, record: null, receipt: RECORD_UNREADABLE_HERMES, coexistence, conflict: RECORD_UNREADABLE_HERMES };
  }
  if (coexistence.collision) {
    return { status: "foreign-hermes", basis: null, record: null, receipt: RECORD_FOREIGN_HERMES, coexistence, conflict: RECORD_FOREIGN_HERMES };
  }
  const conflict = ownershipConflict(ours.status, ours.record || {}, installationId, port, fingerprint);
  if (conflict === RECORD_UNREADABLE_CLAIM) {
    return { status: "unreadable-claim", basis: null, record: null, receipt: RECORD_UNREADABLE_CLAIM, coexistence, conflict };
  }
  if (conflict === RECORD_FOREIGN_OWNER) {
    return { status: "foreign-gateway", basis: null, record: null, receipt: RECORD_FOREIGN_OWNER, coexistence, conflict };
  }
  if (ours.status === "ok") {
    const basis = ours.record.ownershipBasis === OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED
      ? OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED
      : OWNERSHIP_BASIS_OBSERVED_SHAPE_MATCH;
    return { status: "owned", basis, record: ours.record, receipt: RECORD_NOT_ATTEMPTED, coexistence, conflict: null };
  }
  return { status: "unclaimed", basis: null, record: null, receipt: RECORD_NOT_ATTEMPTED, coexistence, conflict: null };
}

function createPrivateRouteReader(deps      = {}) {
  const injectedRun = typeof deps.run === "function" ? deps.run : null;
  const probeTarget = typeof deps.probeLoopbackTarget === "function" ? deps.probeLoopbackTarget : defaultProbeLoopbackTarget;
  const injectedFrontDoor = typeof deps.probeFrontDoor === "function" ? deps.probeFrontDoor : null;
  const clock = typeof deps.now === "function" ? deps.now : nowIso;

  return async function readPrivateRoute(relayPort     , context      = {}) {
    const port = servePort(context.servePort);
    const installationId = context && context.installation && typeof context.installation.id === "string"
      ? context.installation.id : null;
    const hostStateDir = typeof context.hostStateDir === "string" && context.hostStateDir
      ? context.hostStateDir : resolveHostStateDir(process.env);

    const cli = readTailscaleCliReceipt(hostStateDir);
    const cliArgv = cli ? cli.argv : null;
    const run = injectedRun || ((args     ) => defaultRunTailscale(args, cliArgv));
    const probeFrontDoor = injectedFrontDoor
      || ((dnsName     , portNumber     ) => defaultProbeFrontDoor(dnsName, portNumber, cli ? cli.socks5 : null));
    const observedAt = clock();
    const base      = {
      schemaVersion: 1,
      status: ROUTE_STATUS_UNKNOWN,
      evidence: REASON_NOT_READ,
      servePort: port,
      observedAt,
      relay: { status: "running", port: boundedPort(relayPort) ? relayPort : null, evidence: "relay-instance-check" },
      network: { status: "unknown", evidence: READ_FAILED },
      route: { classification: CLASSIFY_UNKNOWN, configured: "unknown", reason: REASON_NOT_READ, readCode: READ_FAILED, presence: "unknown", target: "unknown", exposure: "unknown" },
      reachability: { target: "not-probed", frontDoor: "not-probed" },
      ownership: { status: "unknown", basis: null, receipt: RECORD_NOT_ATTEMPTED, evidence: "route-not-observed" },
      proposal: { status: "withheld", applyCommand: null, reason: REASON_NOT_READ },
      teardown: { status: "withheld", command: null, reason: "route_not_observed" },
      phoneAddress: { status: "unavailable", scheme: "wss", servePort: port, host: "node-tailnet-dns-name", hostSource: "operator-terminal-tailscale-status", reason: REASON_NOT_READ },
      coexistence: { hermesReceipt: "unknown", hermesServePort: null, collision: false, evidence: "not-read" },
      receiptPolicy: "observation-evidence-only-never-a-host-or-network-mutation",
    };
    if (!boundedPort(relayPort)) {
      base.evidence = REASON_NO_RELAY_PORT;
      base.route.reason = REASON_NO_RELAY_PORT;
      base.proposal.reason = REASON_NO_RELAY_PORT;
      return base;
    }

    const [serve, node] = await Promise.all([readServeStatus(run), readNodeState(run)]);
    base.network = { status: node.network, evidence: node.network === "unknown" ? node.code : "tailscale-backend-state" };
    base.route.readCode = serve.code;
    if (serve.code !== READ_OK || node.network === "unknown") {
      const code = serve.code !== READ_OK ? serve.code : node.code;
      base.evidence = code;
      base.route.reason = REASON_NOT_READ;
      base.proposal.reason = code;
      base.phoneAddress.reason = code;
      return base;
    }
    if (node.network === "offline") {
      base.status = ROUTE_STATUS_OFFLINE;
      base.evidence = REASON_NETWORK_OFFLINE;
      base.route.reason = REASON_NETWORK_OFFLINE;
      base.proposal.reason = REASON_NETWORK_OFFLINE;
      base.phoneAddress.reason = REASON_NETWORK_OFFLINE;
      return base;
    }

    const classified = classifyServeDocument(serve.document, { dnsName: node.dnsName, relayPort, port });
    const fingerprint = fingerprintNodeIdentity(node.dnsName);
    const ourTarget = `${LOOPBACK}:${relayPort}`;
    base.route = {
      classification: classified.classification,
      configured: classified.configured,
      reason: classified.reason,
      readCode: serve.code,
      presence: classified.classification === CLASSIFY_ABSENT ? "absent"
        : classified.classification === CLASSIFY_UNKNOWN && classified.configured !== "yes" ? "unknown" : "present",
      target: classified.classification === CLASSIFY_ABSENT ? "none"
        : classified.forward === ourTarget ? "owning-relay"
          : classified.forward ? "different-target" : "unknown",
      exposure: classified.reason === REASON_FUNNEL_ENABLED ? "public-funnel"
        : classified.classification === CLASSIFY_UNKNOWN ? "unknown" : "tailnet-only",
    };
    base.evidence = classified.reason;

    const ours = readJsonReceipt(hostStateDir ? path.join(hostStateDir, OPENCLAW_ROUTE_RECEIPT_FILENAME) : null);
    const hermes = readJsonReceipt(hostStateDir ? path.join(hostStateDir, HERMES_ROUTE_RECEIPT_FILENAME) : null);
    const ownership = ownershipFromReceipts(ours, hermes, installationId, port, fingerprint);
    base.coexistence = ownership.coexistence;
    base.ownership = { status: ownership.status, basis: ownership.basis, receipt: ownership.receipt, evidence: "bundle-scoped-route-receipt" };
    const foreignClaim = ownership.conflict !== null;
    const command = applyCommand(relayPort, port, cliArgv);

    const withhold = (reason     ) => { base.proposal = { status: "withheld", applyCommand: null, reason }; };
    const present = () => { base.proposal = { status: "presented", applyCommand: command, reason: "route_action_required" }; };
    const notNeeded = () => { base.proposal = { status: "not-needed", applyCommand: null, reason: REASON_MATCHES }; };

    const recordProposal = async () => {
      if (!hostStateDir || !installationId || !fingerprint) { base.ownership.receipt = RECORD_INCOMPLETE; return; }
      try {
        const outcome = await withReceiptLock(hostStateDir, async () => {
          const current = readJsonReceipt(path.join(hostStateDir, OPENCLAW_ROUTE_RECEIPT_FILENAME));
          const currentHermes = readJsonReceipt(path.join(hostStateDir, HERMES_ROUTE_RECEIPT_FILENAME));
          const conflict = ownershipFromReceipts(current, currentHermes, installationId, port, fingerprint).conflict;
          if (conflict) return conflict;
          const known = current.status === "ok" ? current.record : null;
          const previous = carriedProposal(known, { command, servePort: port, fingerprint, owner: installationId });
          const body = buildRouteReceiptBody({
            observedAt: observedAt,
            servePort: port,
            relayPort: null,
            previousObservedTarget: known?.observedTarget || known?.previousObservedTarget || null,
            nodeIdentityFingerprint: fingerprint,
            owningGatewayFingerprint: installationId,
            proposedCommand: command,
            cliArgv,
            proposedAt: previous || observedAt,
          });
          const filePath = path.join(hostStateDir, OPENCLAW_ROUTE_RECEIPT_FILENAME);
          if (current.status === "missing") claimJsonReceipt(filePath, body);
          else writeJsonReceiptDurable(filePath, body);
          return RECORD_PROPOSED;
        });
        base.ownership.receipt = outcome.locked ? outcome.value : RECORD_UNAVAILABLE;
      } catch (error     ) {
        base.ownership.receipt = error && error.code === "already_claimed" ? RECORD_FOREIGN_OWNER : RECORD_UNAVAILABLE;
      }
      if (base.ownership.receipt === RECORD_PROPOSED) {
        base.ownership.status = "owned";
        base.ownership.basis = OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED;
      }
    };

    const applyRecordOutcome = () => {
      const code = base.ownership.receipt;
      if (code === RECORD_FOREIGN_OWNER) {
        base.ownership.status = "foreign-gateway"; base.ownership.basis = null;
        return code;
      }
      if (code === RECORD_FOREIGN_HERMES) {
        base.ownership.status = "foreign-hermes"; base.ownership.basis = null;
        return code;
      }
      if (code === RECORD_UNREADABLE_CLAIM || code === RECORD_UNREADABLE_HERMES) {
        base.ownership.status = "unreadable-claim"; base.ownership.basis = null;
        return code;
      }
      return null;
    };

    const proposeOrWithhold = async () => {
      await recordProposal();
      const conflict = applyRecordOutcome();
      if (conflict) {
        base.status = ROUTE_STATUS_CONFLICTING;
        base.evidence = conflict;
        withhold(conflict);
        return;
      }
      if (base.ownership.receipt === RECORD_PROPOSED) present();
      else withhold(base.ownership.receipt);
    };

    const recordObservation = async () => {
      if (!hostStateDir || !installationId || !fingerprint) { base.ownership.receipt = RECORD_INCOMPLETE; return null; }
      try {
        const outcome = await withReceiptLock(hostStateDir, async () => {
          const current = readJsonReceipt(path.join(hostStateDir, OPENCLAW_ROUTE_RECEIPT_FILENAME));
          const currentHermes = readJsonReceipt(path.join(hostStateDir, HERMES_ROUTE_RECEIPT_FILENAME));
          const conflict = ownershipFromReceipts(current, currentHermes, installationId, port, fingerprint).conflict;
          if (conflict) return { code: conflict, body: null };
          const known = current.status === "ok" ? current.record : null;
          const sameRoute = !!known && known.servePort === port && known.observedTarget === ourTarget && known.nodeIdentityFingerprint === fingerprint;
          const body = buildRouteReceiptBody({
            observedAt: observedAt,
            servePort: port,
            relayPort,
            nodeIdentityFingerprint: fingerprint,
            owningGatewayFingerprint: installationId,
            proposedCommand: command,
            cliArgv,
            firstObservedAt: sameRoute && typeof known.firstObservedAt === "string" ? known.firstObservedAt : null,

            proposedAt: carriedProposal(known, { command, servePort: port, fingerprint, owner: installationId }),
          });
          const filePath = path.join(hostStateDir, OPENCLAW_ROUTE_RECEIPT_FILENAME);
          if (current.status === "missing") claimJsonReceipt(filePath, body);
          else writeJsonReceiptDurable(filePath, body);
          return { code: RECORD_WRITTEN, body };
        });
        if (!outcome.locked) { base.ownership.receipt = RECORD_UNAVAILABLE; return null; }
        base.ownership.receipt = outcome.value.code;
        return outcome.value.body;
      } catch (error     ) {
        base.ownership.receipt = error && error.code === "already_claimed" ? RECORD_FOREIGN_OWNER : RECORD_UNAVAILABLE;
        return null;
      }
    };

    const { classification, reason } = classified;

    if (classification === CLASSIFY_UNKNOWN) {
      base.status = ROUTE_STATUS_UNKNOWN;
      withhold(reason);
      base.teardown.reason = reason;
      base.phoneAddress.reason = reason;
      return base;
    }

    if (foreignClaim) {

      base.status = ROUTE_STATUS_CONFLICTING;
      base.evidence = ownership.conflict;
      withhold(ownership.conflict);
      base.teardown.reason = ownership.conflict;
      base.phoneAddress.reason = ownership.conflict;
      return base;
    }

    if (classification === CLASSIFY_ABSENT) {
      base.status = ROUTE_STATUS_MISSING;
      base.teardown.reason = REASON_NO_ROUTE_AT_PORT;
      base.phoneAddress.reason = REASON_NO_ROUTE_AT_PORT;
      if (!fingerprint) { withhold(REASON_NO_DNS_IDENTITY); return base; }
      await proposeOrWithhold();
      return base;
    }

    if (classification === CLASSIFY_WRONG) {
      base.teardown.reason = reason;
      base.phoneAddress.reason = reason;
      if (reason === REASON_FUNNEL_ENABLED) {
        base.status = ROUTE_STATUS_EXPOSED;
        withhold(reason);
        return base;
      }
      if (WEB_OCCUPIED_REASONS.has(reason)) {
        base.status = ROUTE_STATUS_CONFLICTING;
        withhold(reason);
        return base;
      }

      const ourReceipt = ownership.status === "owned" &&
        (ownership.record.observedTarget || ownership.record.previousObservedTarget) === classified.forward &&
        classified.terminate === node.dnsName;
      const aimedAtUs = classified.forward === ourTarget && (classified.terminate === null || classified.terminate === node.dnsName);
      if (ourReceipt || aimedAtUs) {
        base.status = ROUTE_STATUS_STALE;
        if (!fingerprint) { withhold(REASON_NO_DNS_IDENTITY); return base; }
        await proposeOrWithhold();
      } else {
        base.status = ROUTE_STATUS_FOREIGN;
        withhold(reason);
      }
      return base;
    }

    const [targetVerdict, frontDoorVerdict] = await Promise.all([
      probeTarget(relayPort),
      probeFrontDoor(node.dnsName, port),
    ]);
    base.reachability = { target: targetVerdict, frontDoor: frontDoorVerdict };
    notNeeded();
    const body = await recordObservation();
    const lostClaim = applyRecordOutcome();
    if (lostClaim) {

      base.status = ROUTE_STATUS_CONFLICTING;
      base.evidence = lostClaim;
      withhold(lostClaim);
      base.teardown = { status: "withheld", command: null, reason: lostClaim };
      base.phoneAddress.reason = lostClaim;
      return base;
    }
    const record = body || (ownership.status === "owned" ? ownership.record : null);
    if (body) {
      base.ownership.status = "owned";
      base.ownership.basis = body.ownershipBasis;
    }
    const agrees = routeReceiptAgrees(record, { servePort: port, relayPort, nodeIdentityFingerprint: fingerprint, installationId });
    if (body && record.ownershipBasis === OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED && agrees && base.ownership.status === "owned") {
      base.teardown = { status: "offered", command: teardownCommand(port, cliArgv), reason: "receipt-and-live-route-agree" };
    } else {
      base.teardown = {
        status: "withheld", command: null,
        reason: !body ? "route_receipt_unavailable"
          : record.ownershipBasis !== OWNERSHIP_BASIS_PROPOSED_THEN_OBSERVED ? "route_not_proposed_by_this_installation"
            : "receipt_and_live_route_disagree",
      };
    }
    if (!body || !agrees || base.ownership.status !== "owned") {
      base.status = ROUTE_STATUS_UNKNOWN;
      base.evidence = base.ownership.receipt;
      base.phoneAddress.reason = base.evidence;
    } else if (targetVerdict === "listening" && frontDoorVerdict === "accepted") {
      base.status = ROUTE_STATUS_HEALTHY;
      base.phoneAddress = { ...base.phoneAddress, status: "verified", reason: "fresh-route-observation" };

      if (typeof context.onVerifiedAddress === "function") {
        context.onVerifiedAddress(`wss://${node.dnsName}:${port}`);
      }
    } else {
      base.status = ROUTE_STATUS_UNREACHABLE;
      base.evidence = targetVerdict !== "listening" ? `relay_target_${targetVerdict}` : `front_door_${frontDoorVerdict}`;
      base.phoneAddress.reason = base.evidence;
    }
    return base;
  };
}

module.exports = { readJsonReceipt, writeJsonReceiptDurable, defaultRunTailscale, normalizeDnsName, readNodeState, readServeStatus, readTailscaleCliReceipt, resolveHostStateDir, tailscaleCommandPrefix, TAILSCALE_CLI_RECEIPT_FILENAME, READ_OK };
