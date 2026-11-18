const process = require("node:process");

const CAPABILITY_CONSENT_COMMAND = "openclaw plugins enable ocuclaw --accept-capabilities";

const PLUGIN_ID = "ocuclaw";
const INSTALLED_INDEX_STATE_KEY = "plugins.installedIndex";

function builtin(name     ) {
  try {
    return typeof process?.getBuiltinModule === "function" ? process.getBuiltinModule(name) : null;
  } catch (_) {
    return null;
  }
}

function recordIntegrity(record     ) {
  return record.integrity ?? record.npmIntegrity ?? record.clawpackSha256 ?? record.gitCommit ?? undefined;
}

function result(status     , evidence     ) {
  return status === "required"
    ? { status, evidence, command: CAPABILITY_CONSENT_COMMAND }
    : { status, evidence };
}

function readCapabilityConsent(options      = {}) {
  const stateDir = options.stateDir;
  if (typeof stateDir !== "string" || !stateDir) return result("unknown", "state-dir-unavailable");
  const fs = builtin("node:fs");
  const path = builtin("node:path");
  if (!fs || !path) return result("unknown", "host-modules-unavailable");
  const dbPath = path.join(stateDir, "state", "openclaw.sqlite");
  let index     ;
  try {

    if (!fs.existsSync(dbPath)) return result("not-applicable", "no-installed-plugin-index");
    const sqlite = builtin("node:sqlite");
    if (!sqlite || typeof sqlite.DatabaseSync !== "function") return result("unknown", "sqlite-unavailable");
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      const table = db.prepare(
        "select name from sqlite_master where type = 'table' and name = 'config_machine_state'",
      ).get();
      if (!table) return result("not-applicable", "no-installed-plugin-index");
      const row = db.prepare("select value_json from config_machine_state where state_key = ?")
        .get(INSTALLED_INDEX_STATE_KEY);
      if (!row) return result("not-applicable", "no-installed-plugin-index");
      const value = JSON.parse(row.value_json);
      index = value && value.index && typeof value.index === "object" ? value.index : value;
    } finally {
      db.close();
    }
  } catch (_) {
    return result("unknown", "installed-plugin-index-unreadable");
  }
  if (!index || typeof index !== "object") return result("unknown", "installed-plugin-index-unreadable");
  const plugins = Array.isArray(index.plugins) ? index.plugins : [];
  const plugin = plugins.find((item     ) => item && item.pluginId === PLUGIN_ID);

  if (plugin && plugin.enabled === false) return result("not-applicable", "plugin-disabled");
  const owner = plugin && typeof plugin.installOwner === "string" ? plugin.installOwner : PLUGIN_ID;
  const records = index.installRecords && typeof index.installRecords === "object" ? index.installRecords : {};
  const record = records[owner];

  if (!record || typeof record !== "object") return result("not-applicable", "no-install-record");
  if (record.acceptedSurface === undefined || typeof record.acceptedSurfaceHash !== "string") {
    return result("required", "install-record-without-accepted-capabilities");
  }
  if (record.acceptedSurfaceIntegrity !== recordIntegrity(record)) {
    return result("required", "accepted-capabilities-for-another-package");
  }
  return result("accepted", "install-record-accepted-capabilities");
}

function capabilityConsentLine(report     ) {
  const consent = report && report.plugin && report.plugin.capabilityConsent;
  if (!consent || consent.status !== "required") return null;
  return `OpenClaw needs you to approve OcuClaw's permissions again. Run: ${consent.command || CAPABILITY_CONSENT_COMMAND}`;
}

module.exports = { CAPABILITY_CONSENT_COMMAND, readCapabilityConsent, capabilityConsentLine };
