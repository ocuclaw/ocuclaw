const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");

const { detectionSignals, detectionVerdict, readProc1Cmdline, resolveHostname } = require("./cloudways-host.cjs");
const { buildTailscaleCliBody, readJsonReceipt, readTailscaleCliReceipt, resolveHostStateDir, TAILSCALE_CLI_RECEIPT_FILENAME, writeJsonReceiptDurable } = require("./private-route.cjs");
const { runKeepingPartialOutput, startHostProcess } = require("../tools/host-process.cjs");
const { adoptableDaemon, ADOPTED_DAEMON_FILENAME, adoptedLogPath, buildAdoptedRecord, DIAL_TAILSCALE_NC, readAdoptedRecord, writeAdoptedRecord } = require("./cloudways-adopt.cjs");

const PLATFORM_BIN_DIR = "/usr/bin";
const PLATFORM_STATE_DIR = "/var/lib/tailscale";
const PLATFORM_SOCKET = "/var/run/tailscale/tailscaled.sock";
const BINARIES_PLATFORM = "platform";
const BINARIES_BUNDLED = "bundled";

const TAILSCALE_MISSING_MESSAGE =
  "Tailscale is missing on this server. Restart your agent from the Cloudways panel to get the current server image, then run setup again.";

const SOCKS5_LISTEN = "127.0.0.1:1055";
const RECEIPT_PROVISIONER = "openclaw ocuclaw cloudways";
const CLOUDWAYS_STATE_FILENAME = "ocuclaw.cloudways.openclaw.json";

const HERMES_RECEIPT_PROVISIONER = "hermes ocuclaw cloudways";
const HERMES_CLOUDWAYS_STATE_FILENAME = "ocuclaw.cloudways.hermes.json";
const BUNDLE_OPENCLAW = "openclaw";
const BUNDLE_HERMES = "hermes";
const CLOUDWAYS_STATE_SCHEMA_VERSION = 1;

const STATE_ABSENT = "absent";
const STATE_STOPPED = "stopped";
const STATE_STARTING = "starting";
const STATE_NEEDS_AUTH = "needs-authorization";
const STATE_RUNNING = "running";
const STATE_UNKNOWN = "unknown";

const STALE_ENROLLMENT_MESSAGE =
  "The last approval link stopped working when the container restarted. Starting a fresh one.";

const AUTH_URL_RE = /https:\/\/login\.tailscale\.com\/\S+/;
const CMD_TIMEOUT_MS = 20000;

function resolveLayout(options      = {}) {
  let home = typeof options.home === "string" && options.home ? options.home : "";
  if (!home) {
    const envHome = typeof process.env.HOME === "string" ? process.env.HOME.trim() : "";
    home = envHome || os.homedir();
  }

  const hostStateDir = typeof options.hostStateDir === "string" && options.hostStateDir
    ? options.hostStateDir
    : resolveHostStateDir({ HOME: process.env.HOME, LOCALAPPDATA: process.env.LOCALAPPDATA });
  const binDir = path.join(home, "bin");
  const stateDir = path.join(home, ".tailscale");
  const runDir = path.join(stateDir, "run");

  const platformBinDir = options.platformBinDir === undefined ? PLATFORM_BIN_DIR : options.platformBinDir;

  const platformTailscaled = typeof platformBinDir === "string" && platformBinDir
    ? [path.join(platformBinDir, "tailscaled"), path.join(path.dirname(platformBinDir), "sbin", "tailscaled")].find(isFile) ?? null
    : null;
  const platform = !!platformTailscaled && isFile(path.join(platformBinDir, "tailscale"));
  const bundledTailscale = path.join(binDir, "tailscale");
  const bundledTailscaled = path.join(binDir, "tailscaled");
  const bundle = options.bundle === BUNDLE_HERMES ? BUNDLE_HERMES : BUNDLE_OPENCLAW;
  const stateFilename = bundle === BUNDLE_HERMES ? HERMES_CLOUDWAYS_STATE_FILENAME : CLOUDWAYS_STATE_FILENAME;
  const own = {
    home,
    hostStateDir,
    bundle,
    provisioner: bundle === BUNDLE_HERMES ? HERMES_RECEIPT_PROVISIONER : RECEIPT_PROVISIONER,
    binDir,
    binarySource: platform ? BINARIES_PLATFORM : BINARIES_BUNDLED,
    tailscale: platform ? path.join(platformBinDir, "tailscale") : bundledTailscale,
    tailscaled: platform ? platformTailscaled : bundledTailscaled,

    bundledTailscale,
    bundledTailscaled,
    stateDir,
    runDir,
    socketPath: path.join(runDir, "tailscaled.sock"),
    logDir: path.join(stateDir, "log"),
    logPath: path.join(stateDir, "log", "tailscaled.log"),
    signInMarker: path.join(stateDir, "needs-authorization"),

    installReceipt: path.join(stateDir, "ocuclaw-install.json"),

    statePath: hostStateDir ? path.join(hostStateDir, stateFilename) : null,
    receiptPath: hostStateDir ? path.join(hostStateDir, TAILSCALE_CLI_RECEIPT_FILENAME) : null,
    legacySupervisorDir: path.join(home, ".local", "share", "tailscale"),

    ownDaemonToken: `--statedir=${stateDir}`,
    adopted: null       ,
  };

  if (options.adopted === null || own.binarySource !== BINARIES_PLATFORM) return own;
  const record = options.adopted && typeof options.adopted === "object"
    ? options.adopted
    : readAdoptedRecord(hostStateDir, adoptionContext(own));
  return record ? withAdoption(own, record) : own;
}

function adoptionContext(layout     ) {
  return { home: layout.home, ours: layout.stateDir, platformTailscaled: layout.tailscaled };
}

function withAdoption(layout     , record     ) {
  return {
    ...layout,
    socketPath: record.socket,
    logPath: record.logPath,
    logDir: path.dirname(record.logPath),
    ownDaemonToken: record.stateFlag,
    adopted: record,
  };
}

function ownIdentityExists(layout     ) {
  return isFile(path.join(layout.stateDir, "tailscaled.state"));
}

function cliArgv(layout     ) {
  return [layout.tailscale, `--socket=${layout.socketPath}`];
}

function daemonArgv(layout     ) {

  if (layout.adopted) return layout.adopted.daemonArgv.slice();
  return [
    layout.tailscaled,
    `--statedir=${layout.stateDir}`,
    `--socket=${layout.socketPath}`,
    "--tun=userspace-networking",
    `--socks5-server=${SOCKS5_LISTEN}`,
  ];
}

function defaultRunCommand(argv     , options      = {}) {
  return runKeepingPartialOutput(argv, {
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : CMD_TIMEOUT_MS,
    ...(options.env ? { env: options.env } : {}),
  });
}

function runnerOf(deps     ) {
  return deps && typeof deps.run === "function" ? deps.run : defaultRunCommand;
}

const { CLOUDWAYS_HOSTNAME_SUFFIX, CLOUDWAYS_RESTART_NOTE, CLOUDWAYS_RESTART_RISK, DETECT_CLOUDWAYS, DETECT_LIKELY, DETECT_NO, detectSync, gatewayRestartAdvice, gatewayRestartRisk, hostIsCloudways, hostSummary, isCloudwaysManagedHost, mentionsGatewayRestart, resetHostSummaryCache } = require("./cloudways-host.cjs");

async function detect(options      = {}) {
  const hostname = resolveHostname(options);
  let proc1 = typeof options.proc1Cmdline === "string" ? options.proc1Cmdline : readProc1Cmdline();
  if (!proc1 && typeof options.proc1Cmdline !== "string") {

    const result      = await runnerOf(options)(["ps", "-o", "args=", "-p", "1"], { timeoutMs: 5000 });
    proc1 = result && result.code === 0 ? String(result.stdout || "").trim() : "";
  }
  const signals = detectionSignals(options, hostname, proc1);
  return { verdict: detectionVerdict(signals), signals, hostname: String(hostname || "") };
}

function binariesPresent(layout     ) {
  try {
    return fs.statSync(layout.tailscale).isFile() && fs.statSync(layout.tailscaled).isFile();
  } catch (_) {
    return false;
  }
}

async function daemonState(layout     , deps      = {}) {
  if (!binariesPresent(layout)) {
    return { state: STATE_ABSENT, detail: "tailscale binaries are not installed" };
  }
  const result      = await runnerOf(deps)(cliArgv(layout).concat(["status", "--json"]), { timeoutMs: 8000 });
  if (!result || result.code === null) {
    const why = result && result.stderr ? String(result.stderr).trim().slice(0, 200) : "no answer";
    return { state: STATE_STOPPED, detail: `tailscale status did not answer: ${why}` };
  }
  let document      = null;
  try {
    const raw = String(result.stdout || "").trim();
    document = raw ? JSON.parse(raw) : null;
  } catch (_) {
    document = null;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    const lowered = `${result.stdout || ""}${result.stderr || ""}`.toLowerCase();
    if (lowered.includes("doesn't appear to be running") || lowered.includes("failed to connect")) {
      return { state: STATE_STOPPED, detail: "socket is not answering" };
    }
    return { state: STATE_UNKNOWN, detail: String(result.stderr || result.stdout || "").trim().slice(0, 200) };
  }
  const backend = typeof document.BackendState === "string" ? document.BackendState : null;
  const self = document.Self && typeof document.Self === "object" ? document.Self : {};
  const report      = {
    state: STATE_UNKNOWN,
    backend,
    nodeName: typeof self.HostName === "string" ? self.HostName : null,
    dnsName: typeof self.DNSName === "string" ? self.DNSName.replace(/\.+$/, "") : null,
    online: typeof self.Online === "boolean" ? self.Online : null,
    keyExpiry: typeof self.KeyExpiry === "string" ? self.KeyExpiry : null,

    authUrl: typeof document.AuthURL === "string" && document.AuthURL ? document.AuthURL : null,
    detail: "",
  };
  if (backend === "Running") {
    report.state = STATE_RUNNING;
  } else if (backend === "NeedsLogin" || backend === "NeedsMachineAuth") {
    report.state = STATE_NEEDS_AUTH;
    report.detail = backend === "NeedsMachineAuth"
      ? "machine approval is pending in the tailnet admin console"
      : "the node must be authorized: run `openclaw ocuclaw cloudways retry`";
  } else if (backend === "NoState" || backend === "Starting") {
    report.state = STATE_STARTING;
  } else if (backend === "Stopped") {
    report.state = fileExists(layout.signInMarker) ? STATE_NEEDS_AUTH : STATE_STOPPED;
    report.detail = "tailscaled is up but `tailscale up` has not been run";
  }
  return report;
}

function isFile(target     ) {
  try { return fs.statSync(target).isFile(); } catch (_) { return false; }
}

function fileExists(target     ) {
  try { fs.accessSync(target); return true; } catch (_) { return false; }
}

function clearNeedsAuthorizationMarker(layout     ) {

  clearEnrollmentDaemon(layout);
  try {
    fs.unlinkSync(layout.signInMarker);
    return true;
  } catch (_) {
    return false;
  }
}

function enrollmentDaemonRecordPath(layout     ) {
  if (layout && typeof layout.enrollmentDaemonRecord === "string") return layout.enrollmentDaemonRecord;
  return path.join(path.dirname(layout.signInMarker), "enrollment-daemon");
}

function daemonIdentity(layout     , deps      = {}) {
  if (deps && typeof deps.daemonIdentity === "function") return deps.daemonIdentity(layout);
  try {
    const stat      = fs.statSync(layout.socketPath, { bigint: true });
    return `${stat.ino} ${stat.mtimeNs}`;
  } catch (_) {
    return null;
  }
}

function readEnrollmentDaemon(layout     ) {
  try {
    const text = fs.readFileSync(enrollmentDaemonRecordPath(layout), "utf8").trim();
    return text || null;
  } catch (_) {
    return null;
  }
}

function writeEnrollmentDaemon(layout     , deps     ) {
  const identity = daemonIdentity(layout, deps);
  if (identity === null) { clearEnrollmentDaemon(layout); return; }
  try {
    fs.writeFileSync(enrollmentDaemonRecordPath(layout), `${identity}\n`, { mode: 0o600 });
  } catch (_) {  }
}

function clearEnrollmentDaemon(layout     ) {
  try { fs.unlinkSync(enrollmentDaemonRecordPath(layout)); } catch (_) {  }
}

async function daemonProcesses(layout     , deps      = {}) {
  const result      = await runnerOf(deps)(["pgrep", "-a", "-f", "tailscaled"], { timeoutMs: 5000 });
  const ours      = [];
  const foreign      = [];
  if (!result || result.code !== 0) return { ours, foreign };
  const wanted = layout.ownDaemonToken || `--statedir=${layout.stateDir}`;
  for (const line of String(result.stdout || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    const cmdline = trimmed.slice(space + 1);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === process.pid) continue;
    const tokens = cmdline.split(/\s+/);
    if (path.basename(tokens[0]) !== "tailscaled") continue;

    if (tokens.includes(wanted)) ours.push({ pid, cmdline: cmdline.slice(0, 200), tokens });
    else foreign.push({ pid, cmdline: cmdline.slice(0, 200), tokens });
  }
  return { ours, foreign };
}

async function tailscaleUpRunning(deps      = {}, layout      = null) {
  const socketToken = layout && layout.socketPath ? `--socket=${layout.socketPath}` : null;
  let result     ;
  try {
    result = await runnerOf(deps)(["pgrep", "-a", "-f", "tailscale"], { timeoutMs: 5000 });
  } catch (_) {
    return null;
  }
  if (!result || result.spawnFailed) return null;
  if (result.code === 1) return false;
  if (result.code !== 0) return null;
  for (const line of String(result.stdout || "").split("\n")) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    const tokens = trimmed.slice(space + 1).split(/\s+/);
    if (path.basename(tokens[0]) !== "tailscale") continue;
    if (socketToken && !tokens.includes(socketToken)) continue;
    if (tokens.slice(1).some((token) => token === "up")) return true;
  }
  return false;
}

async function gatewayProcessRunning(deps      = {}) {
  let result     ;
  try {
    result = await runnerOf(deps)(["pgrep", "-a", "-f", "openclaw-gateway"], { timeoutMs: 5000 });
  } catch (_) {
    return null;
  }
  if (!result || result.spawnFailed) return null;
  if (result.code === 1) return false;
  if (result.code !== 0) return null;
  for (const line of String(result.stdout || "").split("\n")) {
    const trimmed = line.trim();
    const space = trimmed.indexOf(" ");
    if (space <= 0) continue;
    const pid = Number(trimmed.slice(0, space));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    return true;
  }
  return false;
}

async function legacyInventory(layout     , deps      = {}) {
  const processes = await daemonProcesses(layout, deps);
  return {
    legacySupervisorDir: layout.legacySupervisorDir,
    legacySupervisorPresent: fileExists(path.join(layout.legacySupervisorDir, "supervisor.py")),
    foreignDaemonProcesses: processes.foreign.map((entry     ) => `${entry.pid} ${entry.cmdline}`),
    ownDaemonPids: processes.ours.map((entry     ) => entry.pid),
  };
}

function refuseIfForeignSupervisor(inventory     ) {
  const foreign = (inventory && inventory.foreignDaemonProcesses) || [];
  if (foreign.length === 0) return null;
  return "another tailscaled is running; stop it first (never run two supervisors): "
    + foreign.join("; ");
}

function platformDaemonSocket(cmdline     ) {
  const tokens = String(cmdline || "").split(/\s+/);
  const onPlatformState = tokens.some((token) => token === `--statedir=${PLATFORM_STATE_DIR}`
    || token.startsWith(`--state=${PLATFORM_STATE_DIR}/`));
  if (!onPlatformState) return null;
  const socket = tokens.find((token) => token.startsWith("--socket="));
  return socket ? socket.slice("--socket=".length) : PLATFORM_SOCKET;
}

async function replaceLoggedOutPlatformDaemons(layout     , deps      = {}) {
  const processes = await daemonProcesses(layout, deps);
  const replaced      = [];
  const kill = typeof deps.kill === "function" ? deps.kill : (pid     , signal     ) => process.kill(pid, signal);
  for (const entry of processes.foreign) {
    const socket = platformDaemonSocket(entry.cmdline);
    if (!socket) continue;
    const result      = await runnerOf(deps)([layout.tailscale, `--socket=${socket}`, "status", "--json"], { timeoutMs: 8000 });
    let backend      = null;
    try { backend = JSON.parse(String((result && result.stdout) || "")).BackendState; } catch (_) { backend = null; }
    if (backend !== "NeedsLogin" && backend !== "NoState") continue;
    try { kill(entry.pid, "SIGTERM"); } catch (_) { continue; }
    replaced.push(entry.pid);
  }
  if (replaced.length === 0) return { replaced };
  const sleep = typeof deps.sleep === "function" ? deps.sleep : defaultSleep;
  const attempts = Number.isFinite(deps.stopAttempts) ? deps.stopAttempts : 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const now = await daemonProcesses(layout, deps);
    if (!now.foreign.some((entry     ) => replaced.includes(entry.pid))) return { replaced };
    await sleep(250);
  }
  return { replaced, stillRunning: replaced };
}

const TWO_IDENTITIES_MESSAGE =
  "Two Tailscale identities are on this server: OcuClaw's own in ~/.tailscale and the one already running. "
  + "Setup will not switch between them by itself, because the server's tailnet name, its certificate and the phone's pairing would change. "
  + "Ask the user which one to keep.";

async function findAdoption(layout     , deps      = {}) {
  if (layout.adopted) return { record: layout.adopted, existing: true };
  if (layout.binarySource !== BINARIES_PLATFORM) return { record: null, notAdoptable: [] };
  const processes = await daemonProcesses(layout, deps);
  const judged = processes.foreign.map((entry     ) => ({ entry, verdict: adoptableDaemon(entry.tokens, adoptionContext(layout)) }));
  const notAdoptable = judged
    .filter((item     ) => !item.verdict.adoptable)
    .map((item     ) => ({ pid: item.entry.pid, reason: item.verdict.reason }));
  const adoptable = judged.filter((item     ) => item.verdict.adoptable);
  if (adoptable.length !== 1 || notAdoptable.length > 0) return { record: null, notAdoptable };
  const { entry, verdict } = adoptable[0];
  if (processes.ours.length > 0 || ownIdentityExists(layout)) {
    return { record: null, notAdoptable, refusal: TWO_IDENTITIES_MESSAGE, candidate: { pid: entry.pid, stateFlag: verdict.stateFlag } };
  }
  const result      = await runnerOf(deps)([layout.tailscale, `--socket=${verdict.socket}`, "status", "--json"], { timeoutMs: 8000 });
  let backend      = null;
  try { backend = JSON.parse(String((result && result.stdout) || "")).BackendState; } catch (_) { backend = null; }
  if (typeof backend !== "string" || !backend) {
    return { record: null, notAdoptable: [{ pid: entry.pid, reason: "not-answering" }] };
  }
  const record = buildAdoptedRecord({
    daemonArgv: entry.tokens,
    stateFlag: verdict.stateFlag,
    socket: verdict.socket,
    logPath: adoptedLogPath(layout.home, layout.logPath),
    adoptedBy: layout.provisioner || RECEIPT_PROVISIONER,
  });
  return { record: { ...record, socks5: verdict.socks5 }, backend, pid: entry.pid };
}

function adoptionSummary(layout     ) {
  if (!layout.adopted) return null;
  return {
    socket: layout.adopted.socket,
    stateFlag: layout.adopted.stateFlag,
    socks5: layout.adopted.socks5 || null,
    logPath: layout.adopted.logPath,
    adoptedBy: layout.adopted.adoptedBy || null,
  };
}

function readCloudwaysState(layout     ) {
  if (!layout.statePath) return null;
  const { record, status } = readJsonReceipt(layout.statePath);
  if (status !== "ok") return null;
  return record;
}

function writeCloudwaysState(layout     , patch     ) {
  if (!layout.statePath) throw new Error("no host state directory");
  const known = readCloudwaysState(layout) || {};
  const body = {
    schemaVersion: CLOUDWAYS_STATE_SCHEMA_VERSION,
    enabled: patch.enabled === undefined ? known.enabled !== false : patch.enabled !== false,
    provisioner: RECEIPT_PROVISIONER,
    version: patch.version || known.version || null,
    stateDir: layout.stateDir,
    socket: layout.socketPath,
    socks5: receiptSocks5(layout),
    ...(layout.adopted ? { adopted: true } : {}),

    installed: Array.isArray(patch.installed) ? patch.installed : (known.installed || []),
    installedAt: known.installedAt || patch.installedAt || null,
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
  writeJsonReceiptDurable(layout.statePath, body);
  return body;
}

function supervisionEnabled(layout     ) {
  const state = readCloudwaysState(layout);
  return Boolean(state && state.enabled !== false);
}

function mkdirHardened(target     ) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch (_) {  }
}

function prepareStateDirs(layout     ) {
  for (const directory of [layout.stateDir, layout.runDir, layout.logDir]) mkdirHardened(directory);
}

async function installedVersion(layout     , deps     ) {
  if (!binariesPresent(layout)) return null;
  const result      = await runnerOf(deps)([layout.tailscale, "version"], { timeoutMs: 8000 });
  if (!result || result.code !== 0) return null;
  const first = String(result.stdout || "").trim().split("\n")[0];
  return first ? first.trim() : null;
}

async function installBinaries(layout     , deps      = {}) {
  if (layout.binarySource !== BINARIES_PLATFORM) throw new Error(TAILSCALE_MISSING_MESSAGE);
  const version = await installedVersion(layout, deps);
  return { binaries: BINARIES_PLATFORM, version, installed: [] };
}

function receiptSocks5(layout     ) {
  if (!layout.adopted) return SOCKS5_LISTEN;
  return layout.adopted.socks5 || null;
}

function writeTailscaleCliReceipt(layout     ) {
  if (!layout.receiptPath) throw new Error("no host state directory");
  const socks5 = receiptSocks5(layout);
  const body = buildTailscaleCliBody({
    argv: cliArgv(layout),
    socks5,

    dial: socks5 ? null : DIAL_TAILSCALE_NC,
    provisioner: RECEIPT_PROVISIONER,
  });
  writeJsonReceiptDurable(layout.receiptPath, body);
  return layout.receiptPath;
}

function layoutSummary(layout     ) {
  return {
    binDir: layout.binDir,
    binarySource: layout.binarySource,
    tailscaled: layout.tailscaled,
    stateDir: layout.stateDir,
    socket: layout.socketPath,
    receipt: layout.receiptPath || "",
    state: layout.statePath || "",
    log: layout.logPath,
    socks5: receiptSocks5(layout),
  };
}

async function install(layout     , deps      = {}) {
  const report      = { ok: false, layout: layoutSummary(layout) };
  const platformDaemons = await replaceLoggedOutPlatformDaemons(layout, deps);
  if (platformDaemons.replaced.length > 0) report.replacedPlatformDaemons = platformDaemons.replaced;

  const adoption      = await findAdoption(layout, deps);
  if (adoption.refusal) {
    report.error = adoption.refusal;
    report.adoptable = adoption.candidate;
    return report;
  }
  if (adoption.notAdoptable && adoption.notAdoptable.length > 0) report.foreignNotAdoptable = adoption.notAdoptable;
  if (adoption.record && !adoption.existing) {
    const { socks5: _socks5, ...body } = adoption.record;
    try {
      writeAdoptedRecord(layout.hostStateDir, body);
    } catch (error     ) {
      report.error = `adoption record: ${error && error.message ? error.message : error}`;
      return report;
    }
    layout = withAdoption(layout, adoption.record);
    report.layout = layoutSummary(layout);
  }
  if (layout.adopted) {
    report.adopted = { ...adoptionSummary(layout), backend: adoption.backend || null, existing: Boolean(adoption.existing) };
  }
  const inventory = await legacyInventory(layout, deps);
  report.legacy = inventory;
  const refusal = refuseIfForeignSupervisor(inventory);
  if (refusal) { report.error = refusal; return report; }
  let binaries     ;
  try {
    binaries = await installBinaries(layout, deps);
  } catch (error     ) {
    report.error = error && error.message ? error.message : String(error);
    return report;
  }
  Object.assign(report, binaries);
  prepareStateDirs(layout);
  if (binaries.binaries === BINARIES_PLATFORM) {
    const move = await moveToPlatformBinary(layout, deps);
    if (move.moved) report.moved = move;
    else if (move.reason === "old-daemon-did-not-stop" || move.reason === "platform-daemon-did-not-start") {
      report.error = `could not move Tailscale onto ${layout.tailscaled}: ${move.reason}`;
      return report;
    }
  }
  try {
    report.receipt = writeTailscaleCliReceipt(layout);
    report.state = writeCloudwaysState(layout, {
      enabled: true,
      version: binaries.version,
      installed: binaries.installed,
      installedAt: new Date().toISOString(),
    });
  } catch (error     ) {
    report.error = `receipt: ${error && error.message ? error.message : error}`;
    return report;
  }

  const ensure = typeof deps.ensureDaemon === "function" ? deps.ensureDaemon : null;
  report.daemon = ensure ? await ensure(layout, deps) : await startDaemon(layout, deps);
  report.ok = true;
  return report;
}

function defaultSpawnDaemon(layout     ) {

  if (layout.adopted) fs.mkdirSync(layout.logDir, { recursive: true, mode: 0o700 });
  else mkdirHardened(layout.logDir);
  const logFd = fs.openSync(layout.logPath, "a", 0o600);
  try {
    const argv = daemonArgv(layout);
    const child = startHostProcess(argv[0], argv.slice(1), {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return { pid: child.pid || null };
  } finally {
    try { fs.closeSync(logFd); } catch (_) {  }
  }
}

async function startDaemon(layout     , deps      = {}) {
  if (!binariesPresent(layout)) {
    return { action: "absent", state: STATE_ABSENT, detail: "tailscale binaries are not installed" };
  }
  const before = await daemonState(layout, deps);
  if (before.state !== STATE_STOPPED && before.state !== STATE_ABSENT) {
    if (before.state === STATE_RUNNING) clearNeedsAuthorizationMarker(layout);
    return { action: "kept", state: before.state, detail: before.detail || "" };
  }
  const processes = await daemonProcesses(layout, deps);
  if (processes.foreign.length > 0) {
    return {
      action: "refused",
      state: before.state,
      detail: refuseIfForeignSupervisor({ foreignDaemonProcesses: processes.foreign.map((entry     ) => `${entry.pid} ${entry.cmdline}`) }),
    };
  }
  if (processes.ours.length > 0) {
    return { action: "starting", state: STATE_STARTING, detail: "tailscaled process exists but its socket is not answering yet" };
  }
  prepareStateDirs(layout);
  const spawnDaemon = typeof deps.spawnDaemon === "function" ? deps.spawnDaemon : defaultSpawnDaemon;
  const sleep = typeof deps.sleep === "function" ? deps.sleep : defaultSleep;
  let spawned     ;
  try {
    spawned = await spawnDaemon(layout);
  } catch (error     ) {
    return { action: "start-failed", state: STATE_STOPPED, detail: String((error && error.message) || error).slice(0, 200) };
  }

  const attempts = Number.isFinite(deps.settleAttempts) ? deps.settleAttempts : 40;
  let state = await daemonState(layout, deps);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (state.state === STATE_RUNNING || state.state === STATE_NEEDS_AUTH) break;
    await sleep(500);
    state = await daemonState(layout, deps);
  }
  if (state.state === STATE_STOPPED || state.state === STATE_ABSENT) {
    return { action: "start-failed", state: state.state, pid: spawned && spawned.pid, detail: `tailscaled did not answer after start; see ${layout.logPath}` };
  }
  if (state.state === STATE_RUNNING) clearNeedsAuthorizationMarker(layout);
  if (!layout.adopted) {
    try { fs.chmodSync(layout.socketPath, 0o600); } catch (_) {  }
  }
  return {
    action: "started",
    state: state.state,
    pid: spawned && spawned.pid,
    detail: state.detail || "",
    ...(layout.adopted ? { adopted: true } : {}),
  };
}

function defaultSleep(ms     ) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function stopDaemon(layout     , deps      = {}) {
  if (layout.adopted) return { daemon: "left-running", pids: [], reason: "adopted" };
  const before = await daemonState(layout, deps);
  if (before.state === STATE_ABSENT) return { daemon: "already-stopped", pids: [] };
  const processes = await daemonProcesses(layout, deps);
  const pids = processes.ours.map((entry     ) => entry.pid);
  if (pids.length === 0 && before.state === STATE_STOPPED) return { daemon: "already-stopped", pids: [] };
  const kill = typeof deps.kill === "function" ? deps.kill : (pid     , signal     ) => process.kill(pid, signal);
  for (const pid of pids) {
    try { kill(pid, "SIGTERM"); } catch (_) {  }
  }
  const sleep = typeof deps.sleep === "function" ? deps.sleep : defaultSleep;
  const attempts = Number.isFinite(deps.stopAttempts) ? deps.stopAttempts : 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const now = await daemonState(layout, deps);
    if (now.state === STATE_STOPPED || now.state === STATE_ABSENT) return { daemon: "stopped", pids };
    await sleep(250);
  }
  return { daemon: "still-running", pids };
}

function bundledBinaryInUse(layout     ) {
  if (layout.binarySource !== BINARIES_PLATFORM) return false;
  const receipt = readTailscaleCliReceipt(layout.hostStateDir);
  if (receipt && receipt.argv[0] === layout.bundledTailscale) return true;
  return isFile(layout.bundledTailscale) || isFile(layout.bundledTailscaled);
}

function downloadedByOcuClaw(layout     ) {
  try {
    const record = JSON.parse(fs.readFileSync(layout.installReceipt, "utf8"));
    return typeof record.url === "string" && record.url.startsWith("https://pkgs.tailscale.com/")
      && typeof record.sha256 === "string";
  } catch (_) {
    return false;
  }
}

function bundledLayout(layout     ) {
  return { ...layout, binarySource: BINARIES_BUNDLED, tailscale: layout.bundledTailscale, tailscaled: layout.bundledTailscaled };
}

async function moveToPlatformBinary(layout     , deps      = {}, options      = {}) {
  if (layout.binarySource !== BINARIES_PLATFORM) return { moved: false, reason: "no-platform-binary" };

  if (layout.adopted) return { moved: false, reason: "adopted" };
  const provisioner = options.provisioner || layout.provisioner || RECEIPT_PROVISIONER;
  const receipt = readTailscaleCliReceipt(layout.hostStateDir);
  if (receipt && receipt.provisioner !== provisioner) {
    return { moved: false, reason: `receipt-provisioned-by-${receipt.provisioner}` };
  }
  const processes = await daemonProcesses(layout, deps);
  const onBundled = processes.ours.filter((entry     ) => entry.cmdline.split(/\s+/)[0] === layout.bundledTailscaled);
  if (!bundledBinaryInUse(layout) && onBundled.length === 0) return { moved: false, reason: "already-on-platform" };
  const report      = { moved: true, restarted: false };
  if (onBundled.length > 0) {
    const stopped = await stopDaemon(layout, deps);
    if (stopped.daemon === "still-running") {
      return { moved: false, reason: "old-daemon-did-not-stop", pids: stopped.pids };
    }
    const started = await startDaemon(layout, deps);
    if (started.action !== "started" && started.action !== "kept") {

      const restored = await startDaemon(bundledLayout(layout), deps);
      return { moved: false, reason: "platform-daemon-did-not-start", daemon: started, restored };
    }
    report.restarted = true;
    report.daemon = started;
  }
  if (receipt && layout.receiptPath) {
    writeJsonReceiptDurable(layout.receiptPath, buildTailscaleCliBody({ argv: cliArgv(layout), socks5: SOCKS5_LISTEN, provisioner }));
    report.receipt = layout.receiptPath;
  }
  const removed      = [];
  if (downloadedByOcuClaw(layout)) {
    for (const target of [layout.bundledTailscale, layout.bundledTailscaled, layout.installReceipt]) {
      try { fs.unlinkSync(target); removed.push(target); } catch (_) {  }
    }
    try { fs.rmdirSync(layout.binDir); removed.push(layout.binDir); } catch (_) {  }
  } else {
    report.bundledKept = "no install receipt names this download";
  }
  report.removed = removed;

  if (provisioner === RECEIPT_PROVISIONER && readCloudwaysState(layout)) {
    writeCloudwaysState(layout, { installed: [], version: await installedVersion(layout, deps) });
  }
  return report;
}

function defaultNodeName(hostname      = null) {
  let raw = hostname;
  if (typeof raw !== "string") {
    try { raw = os.hostname(); } catch (_) { raw = "host"; }
  }
  const first = String(raw || "host").split(".")[0];
  const cleaned = first.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "host";
  return `ocuclaw-${cleaned}`.slice(0, 63);
}

async function enroll(layout     , deps      = {}, options      = {}) {
  const clock = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function" ? deps.sleep : defaultSleep;
  const waitMs = Math.max(1000, Math.min(Number(options.waitS || 90) * 1000, 90000));
  const commandMs = Math.max(5000, Number(options.timeoutS || 25) * 1000);
  const deadline = clock() + waitMs;
  const before = await daemonState(layout, deps);
  if (before.state === STATE_ABSENT || before.state === STATE_STOPPED || before.state === STATE_UNKNOWN) {
    return {
      ok: false,
      state: before.state,
      error: before.detail || "tailscaled is not running; run install first",
    };
  }
  if (before.state === STATE_RUNNING) {
    clearNeedsAuthorizationMarker(layout);
    return { ok: true, state: STATE_RUNNING, nodeName: before.nodeName, dnsName: before.dnsName, authUrl: null };
  }

  const upSeconds = Math.max(5, Math.floor(commandMs / 1000) - 5);
  const argv = cliArgv(layout).concat(["up", `--timeout=${upSeconds}s`]);
  if (options.hostname) argv.push(`--hostname=${options.hostname}`);
  else if (!before.dnsName) {

    argv.push(`--hostname=${defaultNodeName(options.machineHostname)}`);
  }
  let out = "";
  let err = "";
  let commandFailed = false;
  let enrollmentStarted = false;
  try {
    enrollmentStarted = fs.readFileSync(layout.signInMarker, "utf8") === "enrollment-started\n";
  } catch (_) { enrollmentStarted = false; }

  let staleMarkerCleared = false;
  if (enrollmentStarted && !before.authUrl && before.backend === "NeedsLogin") {
    const recorded = readEnrollmentDaemon(layout);
    const current = daemonIdentity(layout, deps);
    const sameDaemon = recorded !== null && current !== null && recorded === current;
    if (!sameDaemon && (await tailscaleUpRunning(deps, layout)) === false) {
      try { fs.unlinkSync(layout.signInMarker); } catch (_) {  }
      clearEnrollmentDaemon(layout);
      enrollmentStarted = false;
      staleMarkerCleared = true;
    }
  }
  if (!before.authUrl && !enrollmentStarted) {

    mkdirHardened(path.dirname(layout.signInMarker));
    fs.writeFileSync(layout.signInMarker, "enrollment-started\n", { mode: 0o600 });

    writeEnrollmentDaemon(layout, deps);
    if (typeof deps.progress === "function") {
      deps.progress("Starting Tailscale registration; waiting up to 90 seconds for its authorization link.");
    }
    const result      = await runnerOf(deps)(argv, { timeoutMs: Math.min(commandMs, Math.max(1000, deadline - clock())) });
    out = String((result && result.stdout) || "");
    err = String((result && result.stderr) || "");
    if (result && result.spawnFailed) {
      try { fs.unlinkSync(layout.signInMarker); } catch (_) {  }
      clearEnrollmentDaemon(layout);
      return {
        ok: false, state: before.state, pending: false, commandFailed: true,
        ...(staleMarkerCleared ? { staleMarkerCleared: true } : {}),
        error: "Tailscale registration command could not start; check cloudways status, then retry.",
      };
    }

    const lowered = err.toLowerCase();
    commandFailed = result && result.code !== null && result.code !== 0
      && !["deadline", "timeout", "timed out", "cancel"].some((reason) => lowered.includes(reason));
  }
  const match = AUTH_URL_RE.exec(`${out}\n${err}`);
  let after = before;
  while (!match && !after.authUrl && after.state !== STATE_RUNNING) {
    if (clock() >= deadline) break;
    if (typeof deps.progress === "function") {
      deps.progress("Registration pending; checking the existing enrollment. No new login is being created.");
    }
    after = await daemonState(layout, deps);
    if (after.state === STATE_ABSENT || after.state === STATE_STOPPED || after.state === STATE_UNKNOWN) break;
    if (after.authUrl || after.state === STATE_RUNNING) break;
    await sleep(Math.min(5000, Math.max(0, deadline - clock())));
  }
  const authUrl = match ? match[0] : (after.state === STATE_NEEDS_AUTH ? after.authUrl : null);
  const result      = {
    ok: after.state === STATE_RUNNING || Boolean(authUrl),
    state: after.state,
    authUrl: authUrl || null,
    nodeName: after.nodeName || null,
    dnsName: after.dnsName || null,
  };
  if (staleMarkerCleared) result.staleMarkerCleared = true;
  if (!result.ok) {
    result.pending = after.state === STATE_NEEDS_AUTH && !commandFailed;
    if (commandFailed) {

      try { fs.unlinkSync(layout.signInMarker); } catch (_) {  }
      clearEnrollmentDaemon(layout);
      result.commandFailed = true;
    }
    result.error = commandFailed
      ? "Tailscale registration command failed and no authorization link appeared; check cloudways status, then retry."
      : result.pending
        ? "Registration is still pending after the bounded wait; run openclaw ocuclaw cloudways retry to observe the same enrollment."
        : "Tailscale daemon is unavailable; run openclaw ocuclaw cloudways status before retrying.";
  }
  if (after.state === STATE_RUNNING) clearNeedsAuthorizationMarker(layout);
  else if (authUrl) {
    mkdirHardened(path.dirname(layout.signInMarker));
    if (!fileExists(layout.signInMarker)) fs.writeFileSync(layout.signInMarker, "", { mode: 0o600 });
  }
  return result;
}

async function status(layout     , deps      = {}, options      = {}) {
  const clock = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function" ? deps.sleep : defaultSleep;
  const deadline = clock() + Math.max(0, Number(options.waitS || 0) * 1000);
  let daemon = await daemonState(layout, deps);
  while (
    daemon.state !== STATE_RUNNING && daemon.state !== STATE_NEEDS_AUTH
    && daemon.state !== STATE_ABSENT && clock() < deadline
  ) {
    await sleep(Math.min(2000, Math.max(100, deadline - clock())));
    daemon = await daemonState(layout, deps);
  }
  const receipt = readTailscaleCliReceipt(layout.hostStateDir);
  const state = readCloudwaysState(layout);
  return {
    detect: await detect(deps),
    daemon,
    needsAuthorizationMarker: fileExists(layout.signInMarker),

    authorizationPending: fileExists(layout.signInMarker) && daemon.state !== STATE_RUNNING,
    binaries: {
      present: binariesPresent(layout),
      path: layout.tailscaled,
      source: layout.binarySource,

      movePending: bundledBinaryInUse(layout),
    },
    receipt: receipt === null ? null : { argv: receipt.argv, socks5: receipt.socks5 ? `${receipt.socks5.host}:${receipt.socks5.port}` : null, provisioner: receipt.provisioner },
    supervisor: {
      owner: "ocuclaw-plugin-relay-service",
      enabled: Boolean(state && state.enabled !== false),
      installed: (state && state.installed) || [],
      version: (state && state.version) || null,
    },
    legacy: await legacyInventory(layout, deps),
    layout: layoutSummary(layout),

    adopted: adoptionSummary(layout),
  };
}

async function daemonSummary(deps      = {}, options      = {}) {
  const layout = resolveLayout(options);
  if (readTailscaleCliReceipt(layout.hostStateDir) === null) return null;
  const state = await daemonState(layout, deps);
  return {
    state: state.state,
    detail: state.detail || "",
    nodeName: state.nodeName || null,
    dnsName: state.dnsName || null,
    online: state.online === undefined ? null : state.online,
    needsAuthorizationMarker: fileExists(layout.signInMarker),
    authorizationPending: fileExists(layout.signInMarker) && state.state !== STATE_RUNNING,
    supervisorEnabled: supervisionEnabled(layout),
    adopted: Boolean(layout.adopted),
  };
}

async function enable(layout     , deps      = {}) {
  await replaceLoggedOutPlatformDaemons(layout, deps);
  const inventory = await legacyInventory(layout, deps);
  const refusal = refuseIfForeignSupervisor(inventory);
  if (refusal) return { ok: false, error: refusal, legacy: inventory };
  if (!binariesPresent(layout)) return { ok: false, error: "tailscale binaries are not installed; run install" };
  let state     ;
  try {
    state = writeCloudwaysState(layout, { enabled: true });
  } catch (error     ) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  const daemon = await startDaemon(layout, deps);
  return { ok: daemon.action !== "refused" && daemon.action !== "start-failed", enabled: state.enabled, daemon };
}

async function disable(layout     , deps      = {}) {
  let enabled      = null;
  try {
    enabled = writeCloudwaysState(layout, { enabled: false }).enabled;
  } catch (error     ) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  const stopped = await stopDaemon(layout, deps);
  return { ok: stopped.daemon !== "still-running", enabled, ...stopped };
}

async function rollback(layout     , deps      = {}, options      = {}) {
  const report      = { ok: false };
  const known = readCloudwaysState(layout);
  const receipt = readTailscaleCliReceipt(layout.hostStateDir);
  let provisioner = receipt && receipt.provisioner;
  if (!receipt && layout.receiptPath) {
    try { provisioner = JSON.parse(fs.readFileSync(layout.receiptPath, "utf8")).provisioner; } catch {}
  }
  const keepReceipt = Boolean(layout.receiptPath && fs.existsSync(layout.receiptPath)
    && provisioner !== RECEIPT_PROVISIONER);
  const sameFile = (left     , right     ) => {
    try { return fs.realpathSync(left) === fs.realpathSync(right); }
    catch { return path.resolve(left) === path.resolve(right); }
  };
  const keepBinaries = keepReceipt && (!receipt || sameFile(receipt.argv[0], layout.tailscale)
    || sameFile(receipt.argv[0], layout.bundledTailscale));
  const stopped = await stopDaemon(layout, deps);
  Object.assign(report, stopped);
  const removed      = [];
  const errors      = [];
  const remove = (target     ) => {
    try {
      fs.unlinkSync(target);
      removed.push(target);
    } catch (error     ) {
      if (!error || error.code !== "ENOENT") errors.push(`${target}: ${error && error.message ? error.message : error}`);
    }
  };
  for (const target of (known && Array.isArray(known.installed) ? known.installed : [])) {
    if (keepBinaries && [layout.tailscale, layout.tailscaled, layout.bundledTailscale, layout.bundledTailscaled]
      .includes(target)) continue;
    if (typeof target === "string" && target) remove(target);
  }
  if (!keepBinaries) remove(layout.installReceipt);
  remove(layout.signInMarker);
  remove(enrollmentDaemonRecordPath(layout));

  if (keepReceipt) {
    report.receiptKept = provisioner || "unknown";
    if (keepBinaries) report.binariesKept = true;
  } else if (layout.receiptPath) remove(layout.receiptPath);

  const adoptedByOther = layout.adopted && layout.adopted.adoptedBy && layout.adopted.adoptedBy !== RECEIPT_PROVISIONER;
  if (!keepReceipt && !adoptedByOther) {
    const adoptedPath = layout.hostStateDir ? path.join(layout.hostStateDir, ADOPTED_DAEMON_FILENAME) : null;
    if (adoptedPath && fs.existsSync(adoptedPath)) remove(adoptedPath);
  } else if (adoptedByOther) report.adoptionKept = layout.adopted.adoptedBy;
  if (layout.adopted) report.adoptedLeftRunning = adoptionSummary(layout);
  if (layout.statePath) remove(layout.statePath);
  if (options.purgeIdentity && keepReceipt) report.identityPurgeSkipped = true;
  else if (options.purgeIdentity) {
    try {
      fs.rmSync(layout.stateDir, { recursive: true, force: true });
      removed.push(layout.stateDir);
    } catch (error     ) {
      errors.push(`${layout.stateDir}: ${error && error.message ? error.message : error}`);
    }
  }
  report.removed = removed;
  if (errors.length > 0) report.errors = errors;
  report.identityKept = !options.purgeIdentity || keepReceipt;
  report.ok = errors.length === 0 && stopped.daemon !== "still-running";
  return report;
}

module.exports = { PLATFORM_BIN_DIR, PLATFORM_STATE_DIR, PLATFORM_SOCKET, BINARIES_PLATFORM, BINARIES_BUNDLED, TAILSCALE_MISSING_MESSAGE, SOCKS5_LISTEN, RECEIPT_PROVISIONER, CLOUDWAYS_STATE_FILENAME, HERMES_RECEIPT_PROVISIONER, HERMES_CLOUDWAYS_STATE_FILENAME, BUNDLE_OPENCLAW, BUNDLE_HERMES, CLOUDWAYS_STATE_SCHEMA_VERSION, STATE_ABSENT, STATE_STOPPED, STATE_STARTING, STATE_NEEDS_AUTH, STATE_RUNNING, STATE_UNKNOWN, STALE_ENROLLMENT_MESSAGE, resolveLayout, adoptionContext, withAdoption, ownIdentityExists, cliArgv, daemonArgv, defaultRunCommand, CLOUDWAYS_HOSTNAME_SUFFIX, CLOUDWAYS_RESTART_NOTE, CLOUDWAYS_RESTART_RISK, DETECT_CLOUDWAYS, DETECT_LIKELY, DETECT_NO, detectSync, gatewayRestartAdvice, gatewayRestartRisk, hostIsCloudways, hostSummary, isCloudwaysManagedHost, mentionsGatewayRestart, resetHostSummaryCache, detect, binariesPresent, daemonState, clearNeedsAuthorizationMarker, enrollmentDaemonRecordPath, daemonIdentity, daemonProcesses, tailscaleUpRunning, gatewayProcessRunning, legacyInventory, refuseIfForeignSupervisor, platformDaemonSocket, replaceLoggedOutPlatformDaemons, TWO_IDENTITIES_MESSAGE, findAdoption, adoptionSummary, readCloudwaysState, writeCloudwaysState, supervisionEnabled, prepareStateDirs, installBinaries, receiptSocks5, writeTailscaleCliReceipt, layoutSummary, install, defaultSpawnDaemon, startDaemon, defaultSleep, stopDaemon, bundledBinaryInUse, moveToPlatformBinary, defaultNodeName, enroll, status, daemonSummary, enable, disable, rollback };
