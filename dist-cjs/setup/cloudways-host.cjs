const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const process = require("node:process");

const CLOUDWAYS_HOSTNAME_SUFFIX = ".cloudwaysagents.com";

const DETECT_CLOUDWAYS = "cloudways";
const DETECT_LIKELY = "likely";
const DETECT_NO = "no";

function onPath(name     , env     ) {
  const raw = env && typeof env.PATH === "string" ? env.PATH : "";
  for (const entry of raw.split(path.delimiter)) {
    if (!entry) continue;
    try {
      fs.accessSync(path.join(entry, name), fs.constants.X_OK);
      return true;
    } catch (_) {  }
  }
  return false;
}

function readProc1Cmdline() {
  try {
    return fs.readFileSync("/proc/1/cmdline", "utf8").replace(/\0/g, " ").trim();
  } catch (_) {
    return "";
  }
}

function detectionSignals(options     , hostname     , proc1     ) {
  const env = options.env || process.env;
  const exists = typeof options.pathExists === "function"
    ? options.pathExists
    : (target     ) => { try { fs.accessSync(target); return true; } catch (_) { return false; } };
  const has = typeof options.which === "function" ? options.which : (name     ) => onPath(name, env);
  return {
    hostname_cloudwaysagents: String(hostname || "").toLowerCase().endsWith(CLOUDWAYS_HOSTNAME_SUFFIX),
    pid1_entrypoint_sh: proc1.includes("entrypoint.sh"),
    no_systemctl: !has("systemctl"),
    no_crontab: !has("crontab"),
    no_sudo: !has("sudo"),
    no_tun_device: !exists("/dev/net/tun"),
  };
}

function detectionVerdict(signals     ) {
  if (signals.hostname_cloudwaysagents) return DETECT_CLOUDWAYS;
  const supporting = Object.keys(signals)
    .filter((key) => key !== "hostname_cloudwaysagents" && signals[key]).length;
  return supporting >= 3 ? DETECT_LIKELY : DETECT_NO;
}

function resolveHostname(options     ) {
  if (typeof options.hostname === "string") return options.hostname;
  try { return os.hostname(); } catch (_) { return ""; }
}

function detectSync(options      = {}) {
  const hostname = resolveHostname(options);
  const proc1 = typeof options.proc1Cmdline === "string" ? options.proc1Cmdline : readProc1Cmdline();
  const signals = detectionSignals(options, hostname, proc1);
  return { verdict: detectionVerdict(signals), signals, hostname: String(hostname || "") };
}

let hostSummaryCache      = null;

function hostSummary(options      = {}) {
  if (hostSummaryCache && !options.refresh) return hostSummaryCache;
  let detected      = null;
  try {
    detected = detectSync(options);
  } catch (_) {

    return { managed: null, detectVerdict: "unknown", guide: null, gatewayRestart: "supported" };
  }
  const managed = detected.verdict === DETECT_CLOUDWAYS ? "cloudways" : null;
  hostSummaryCache = {
    managed,
    detectVerdict: detected.verdict,

    guide: managed ? "references/cloudways.md" : null,

    gatewayRestart: managed ? "never-on-this-host" : "supported",
  };
  return hostSummaryCache;
}

function resetHostSummaryCache() {
  hostSummaryCache = null;
}

const CLOUDWAYS_RESTART_NOTE =
  "Do not run `openclaw gateway restart` on this Cloudways managed host: it is a no-op that prints \"Gateway service disabled\" and changes nothing. Plugin installs and config changes hot-load here; re-read journey a few seconds later instead. The only real restart bounces the whole container, and references/cloudways.md says when that is needed and how to do it.";

function isCloudwaysManagedHost() {
  try {
    return hostSummary().managed === "cloudways";
  } catch (_) {
    return false;
  }
}

function hostIsCloudways(host     ) {
  return !!host && typeof host === "object" && host.managed === "cloudways";
}

function resolveCloudways(host     ) {
  return host === undefined ? isCloudwaysManagedHost() : hostIsCloudways(host);
}

function gatewayRestartAdvice(normal     , host      = undefined) {
  if (!resolveCloudways(host)) return normal;
  const text = String(normal || "").trim();
  return text ? `${text} ${CLOUDWAYS_RESTART_NOTE}` : CLOUDWAYS_RESTART_NOTE;
}

const GATEWAY_RESTART_PATTERN =
  /restart(?:ing)?\s+the\s+(?:openclaw\s+)?gateway|gateway\s+restart/i;

function mentionsGatewayRestart(text     ) {
  return GATEWAY_RESTART_PATTERN.test(String(text || ""));
}

const CLOUDWAYS_RESTART_RISK =
  "On this Cloudways managed host `openclaw gateway restart` changes nothing, so this step interrupts nobody. Only a full container restart does, and references/cloudways.md says when that is needed.";

function gatewayRestartRisk(normal     , host      = undefined) {
  if (!resolveCloudways(host)) return normal;
  return mentionsGatewayRestart(normal) ? CLOUDWAYS_RESTART_RISK : normal;
}

module.exports = { CLOUDWAYS_HOSTNAME_SUFFIX, CLOUDWAYS_RESTART_NOTE, CLOUDWAYS_RESTART_RISK, DETECT_CLOUDWAYS, DETECT_LIKELY, DETECT_NO, detectionSignals, detectionVerdict, detectSync, gatewayRestartAdvice, gatewayRestartRisk, hostIsCloudways, hostSummary, isCloudwaysManagedHost, mentionsGatewayRestart, readProc1Cmdline, resetHostSummaryCache, resolveHostname };
