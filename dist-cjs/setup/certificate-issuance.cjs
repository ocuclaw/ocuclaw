const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const process = require("node:process");

const ISSUANCE_AVAILABLE = "available";
const ISSUANCE_UNAVAILABLE = "unavailable";
const ISSUANCE_UNKNOWN = "unknown";
const ISSUANCE_PENDING = "pending";

const UNAVAILABLE_SIGNATURES = [
  "does not support getting tls certs",
  "https must be enabled in the admin panel",
  "https is not enabled",
];

const OUTPUT_LIMIT = 4096;
const CERT_DIR_PREFIX = "ocuclaw-cert-";

const STALE_DIR_MS = 15 * 60 * 1000;

function sweepStaleDirs(tmpRoot     ) {
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    for (const name of fs.readdirSync(tmpRoot)) {
      if (!name.startsWith(CERT_DIR_PREFIX)) continue;
      const folder = path.join(tmpRoot, name);
      const info = fs.lstatSync(folder);
      if (!info.isDirectory() || (uid !== null && info.uid !== uid)) continue;
      if (Date.now() - info.mtimeMs < STALE_DIR_MS) continue;
      fs.rmSync(folder, { recursive: true, force: true });
    }
  } catch (_) {  }
}

function certificateCommand(tailscaleArgv     , dnsName     , dir     ) {
  const prefix = Array.isArray(tailscaleArgv) && tailscaleArgv.length > 0
    ? tailscaleArgv.slice()
    : ["tailscale"];
  return prefix.concat([
    "cert",
    "--cert-file",
    path.join(dir, "cert.pem"),
    "--key-file",
    path.join(dir, "key.pem"),
    dnsName,
  ]);
}

function certificateOutcome(code     , output     ) {
  if (code === 0) return ISSUANCE_AVAILABLE;
  const lowered = String(output || "").toLowerCase();
  if (UNAVAILABLE_SIGNATURES.some((signature     ) => lowered.includes(signature))) {
    return ISSUANCE_UNAVAILABLE;
  }
  return ISSUANCE_UNKNOWN;
}

function startCertificateIssuance(tailscaleArgv     , dnsName     , budgetMs     , deps      = {}) {
  const spawnFn = typeof deps.spawn === "function" ? deps.spawn : spawn;
  const tmpRoot = typeof deps.tmpDir === "string" && deps.tmpDir ? deps.tmpDir : os.tmpdir();
  let outcome      = null;
  let output = "";
  let child      = null;
  let timer      = null;
  let dir      = null;
  const startedAt = Date.now();
  let ranMs      = null;

  const removeFiles = () => {
    const folder = dir;
    dir = null;
    if (!folder) return;
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch (_) {  }
  };
  const settle = (value     ) => {
    if (outcome === null) {
      outcome = value;
      ranMs = Date.now() - startedAt;
    }
    if (timer) { clearTimeout(timer); timer = null; }
  };
  const stopChild = () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch (_) {  }
    }
  };

  sweepStaleDirs(tmpRoot);
  try {
    dir = fs.mkdtempSync(path.join(tmpRoot, CERT_DIR_PREFIX));
    const argv = certificateCommand(tailscaleArgv, dnsName, dir);
    child = spawnFn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  } catch (_) {
    settle(ISSUANCE_UNKNOWN);
    removeFiles();
    return { poll: () => outcome, ranMs: () => ranMs, stop: () => {} };
  }

  const collect = (chunk     ) => {
    if (output.length < OUTPUT_LIMIT) output += String(chunk);
  };
  if (child.stdout) child.stdout.on("data", collect);
  if (child.stderr) child.stderr.on("data", collect);
  child.once("error", () => {
    settle(ISSUANCE_UNKNOWN);
    removeFiles();
  });
  child.once("close", (code     ) => {
    settle(certificateOutcome(code, output));
    removeFiles();
  });
  const budget = Number(budgetMs) > 0 ? Number(budgetMs) : 0;
  timer = setTimeout(() => {
    settle(ISSUANCE_PENDING);
    stopChild();
  }, budget);

  return {
    poll: () => outcome,

    ranMs: () => ranMs,

    stop: () => {
      settle(ISSUANCE_PENDING);
      stopChild();
      removeFiles();
    },
  };
}

const ENABLE_LINK_TIMEOUT_MS = 10000;
const ENABLE_LINK_PATH = "/localapi/v0/query-feature?feature=serve";
const ENABLE_LINK_MAX_LENGTH = 2048;
const ENABLE_LINK_RE = /^https:\/\/[A-Za-z0-9\-._~:\/?#\[\]@!$&'()*+,;=%]+$/;
const ENABLE_LINK_BODY_LIMIT = 64 * 1024;

function enableLinkFrom(document     ) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const url = document.URL;
  if (typeof url !== "string" || url.length > ENABLE_LINK_MAX_LENGTH || !ENABLE_LINK_RE.test(url)) return null;
  return url;
}

function queryHttpsEnableLink(socketPath     , timeoutMs      = ENABLE_LINK_TIMEOUT_MS) {
  return new Promise((resolve     ) => {
    if (typeof socketPath !== "string" || !socketPath) {
      resolve(null);
      return;
    }
    let settled = false;
    let request      = null;
    const settle = (value     ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (request) request.destroy(); } catch (_) {  }
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), Number(timeoutMs) > 0 ? Number(timeoutMs) : ENABLE_LINK_TIMEOUT_MS);
    try {
      request = http.request({
        socketPath,
        method: "POST",
        path: ENABLE_LINK_PATH,
        headers: { Host: "local-tailscaled.sock", "Content-Length": "0" },
        agent: false,
      }, (response     ) => {
        if (response.statusCode !== 200) {
          response.resume();
          settle(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk     ) => {
          body += chunk;
          if (body.length > ENABLE_LINK_BODY_LIMIT) settle(null);
        });
        response.on("end", () => {
          try {
            settle(enableLinkFrom(JSON.parse(body)));
          } catch (_) {
            settle(null);
          }
        });
        response.on("error", () => settle(null));
      });
      request.on("error", () => settle(null));
      request.end();
    } catch (_) {
      settle(null);
    }
  });
}

module.exports = { ISSUANCE_AVAILABLE, ISSUANCE_UNAVAILABLE, ISSUANCE_UNKNOWN, ISSUANCE_PENDING, certificateCommand, certificateOutcome, startCertificateIssuance, ENABLE_LINK_TIMEOUT_MS, enableLinkFrom, queryHttpsEnableLink };
