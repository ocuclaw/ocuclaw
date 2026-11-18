const fs = require("node:fs");
const path = require("node:path");

const { readJsonReceipt, writeJsonReceiptDurable } = require("./private-route.cjs");
const { DIAL_TAILSCALE_NC, parseSocks5 } = require("./tailnet-dial.cjs");

const ADOPTED_DAEMON_FILENAME = "ocuclaw.tailscale-adopted.json";
const ADOPTED_SCHEMA_VERSION = 1;
const ADOPTED_KIND = "cloudways-platform";
const ADOPTED_DEFAULT_SOCKET = "/var/run/tailscale/tailscaled.sock";

const ALLOWED_FLAGS = new Set(["tun", "state", "statedir", "socket", "port", "socks5-server", "verbose"]);

function insideDir(target        , dir        ) {
  const base = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return target.startsWith(base);
}

function validFlagValue(name        , value        ) {
  if (!value) return false;
  if (name === "socket") return path.isAbsolute(value);
  if (name === "port") {
    if (!/^[0-9]{1,5}$/.test(value)) return false;
    const port = Number(value);
    return port >= 1 && port <= 65535;
  }
  if (name === "socks5-server") return parseSocks5(value) !== null;
  if (name === "verbose") return /^[0-9]{1,2}$/.test(value);
  return true;
}

function adoptableDaemon(argv     , context     ) {
  const tokens = Array.isArray(argv) ? argv.map((token     ) => String(token)) : [];
  const home = path.normalize(String(context && context.home || ""));
  const ours = path.normalize(String(context && context.ours || ""));
  const platformTailscaled = String(context && context.platformTailscaled || "");
  if (!platformTailscaled || tokens[0] !== platformTailscaled) return { adoptable: false, reason: "not-platform-binary" };
  const flags                           = {};
  for (const token of tokens.slice(1)) {
    const match = /^--([a-z0-9-]+)=(.*)$/.exec(token);
    if (!match || !ALLOWED_FLAGS.has(match[1]) || !validFlagValue(match[1], match[2])) {
      return { adoptable: false, reason: "flag-not-allowed" };
    }
    (flags[match[1]] = flags[match[1]] || []).push(match[2]);
  }

  if (Object.entries(flags).some(([name, values]) => values.length > 1 && name !== "state" && name !== "statedir")) {
    return { adoptable: false, reason: "flag-not-allowed" };
  }
  if (!flags.tun || flags.tun[0] !== "userspace-networking") return { adoptable: false, reason: "not-userspace" };
  const stateFlags = ["state", "statedir"].filter((name) => flags[name]);
  if (stateFlags.length === 0) return { adoptable: false, reason: "no-state-flag" };
  if (stateFlags.length > 1 || flags[stateFlags[0]].length > 1) return { adoptable: false, reason: "two-state-flags" };
  const stateName = stateFlags[0];
  const statePath = path.normalize(flags[stateName][0]);
  if (!path.isAbsolute(statePath)) return { adoptable: false, reason: "state-outside-home" };
  if (ours && (statePath === ours || insideDir(statePath, ours))) return { adoptable: false, reason: "own-state-dir" };
  if (!home || home === path.sep || !insideDir(statePath, home)) return { adoptable: false, reason: "state-outside-home" };
  return {
    adoptable: true,
    stateFlag: `--${stateName}=${flags[stateName][0]}`,
    socket: flags.socket ? flags.socket[0] : ADOPTED_DEFAULT_SOCKET,
    socks5: flags["socks5-server"] ? flags["socks5-server"][0] : null,
  };
}

function adoptedRecordPath(hostStateDir     ) {
  return typeof hostStateDir === "string" && hostStateDir ? path.join(hostStateDir, ADOPTED_DAEMON_FILENAME) : null;
}

function adoptedLogPath(home        , ownLogPath        ) {
  const logs = path.join(home, "logs");
  try {
    if (fs.statSync(logs).isDirectory()) return path.join(logs, "tailscale.log");
  } catch (_) {  }
  return ownLogPath;
}

function buildAdoptedRecord(input     ) {
  return {
    schemaVersion: ADOPTED_SCHEMA_VERSION,
    kind: ADOPTED_KIND,
    daemonArgv: input.daemonArgv.slice(),
    stateFlag: input.stateFlag,
    socket: input.socket,
    logPath: input.logPath,
    adoptedBy: String(input.adoptedBy || "unknown"),
    adoptedAt: input.adoptedAt || new Date().toISOString(),
  };
}

function readAdoptedRecord(hostStateDir     , context     ) {
  const filePath = adoptedRecordPath(hostStateDir);
  if (!filePath) return null;
  const { record, status } = readJsonReceipt(filePath);
  if (status !== "ok" || !record || record.kind !== ADOPTED_KIND) return null;
  if (!Array.isArray(record.daemonArgv) || !record.daemonArgv.every((part     ) => typeof part === "string")) return null;
  const verdict      = adoptableDaemon(record.daemonArgv, context);
  if (!verdict.adoptable) return null;
  if (record.stateFlag !== verdict.stateFlag || record.socket !== verdict.socket) return null;

  const home = path.normalize(String(context && context.home || ""));
  const logPath = typeof record.logPath === "string" && path.isAbsolute(record.logPath)
    && path.normalize(record.logPath) === record.logPath && home && home !== path.sep && insideDir(record.logPath, home)
    ? record.logPath : null;
  if (!logPath) return null;
  return {
    daemonArgv: record.daemonArgv.slice(),
    stateFlag: verdict.stateFlag,
    socket: verdict.socket,
    socks5: verdict.socks5,
    logPath,
    adoptedBy: typeof record.adoptedBy === "string" ? record.adoptedBy : "unknown",
    adoptedAt: typeof record.adoptedAt === "string" ? record.adoptedAt : null,
  };
}

function writeAdoptedRecord(hostStateDir     , body     ) {
  const filePath = adoptedRecordPath(hostStateDir);
  if (!filePath) throw new Error("no host state directory");
  writeJsonReceiptDurable(filePath, body);
  return filePath;
}

function removeAdoptedRecord(hostStateDir     ) {
  const filePath = adoptedRecordPath(hostStateDir);
  if (!filePath) return false;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { DIAL_TAILSCALE_NC, ADOPTED_DAEMON_FILENAME, ADOPTED_SCHEMA_VERSION, ADOPTED_KIND, ADOPTED_DEFAULT_SOCKET, adoptableDaemon, adoptedRecordPath, adoptedLogPath, buildAdoptedRecord, readAdoptedRecord, writeAdoptedRecord, removeAdoptedRecord };
