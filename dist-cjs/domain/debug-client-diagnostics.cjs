const { redactDiagnosticData, redactEvents } = require("./debug-bundle-redaction.cjs");

const CLIENT_DIAGNOSTICS_MAX_BYTES = 128 * 1024;
const CLIENT_DIAGNOSTICS_FILES = [
  "client/connection-log.json", "client/errors.json", "client/console-ring.json", "client/build-env.json",
  "client/prior-session/events.jsonl", "client/prior-session/connection-log.json", "client/prior-session/errors.json",
];
const ENV_KEYS = new Set(["appVersion", "platform", "userAgent", "online", "language", "lastTerminalErrorClass", "diag.persistVerdict"]);
const object = (value         )                               => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value         ) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
const time = (value         ) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const byteLength = (value        ) => new TextEncoder().encode(value).byteLength;
const safeText = (value         , max = 120) => typeof value === "string"
  ? redactDiagnosticData({ value: value.slice(0, max) }).value : "";

function parseClientReportDiagnostics(raw         , { mode = "off" } = {}) {
  const absent = (status        ) => ({ files: new Map                (), metadata: { status } });
  if (raw == null) return absent("missing");
  if (typeof raw !== "string" || byteLength(raw) > CLIENT_DIAGNOSTICS_MAX_BYTES) return absent("invalid");
  let doc;
  try { doc = JSON.parse(raw); } catch { return absent("invalid"); }
  if (!object(doc) || doc.version !== 1 || !object(doc.files) ||
      Object.keys(doc.files).some(name => !CLIENT_DIAGNOSTICS_FILES.includes(name))) return absent("invalid");
  const files = new Map();
  let omittedRecords = 0;
  let invalidFiles = 0;
  for (const name of CLIENT_DIAGNOSTICS_FILES) {
    omittedRecords += count(doc.omittedByFile?.[name]);
    const content = doc.files[name];
    if (content === undefined) continue;
    if (typeof content !== "string" || byteLength(content) > 16 * 1024) { invalidFiles++; continue; }
    try {
      if (name === "client/build-env.json") {
        const parsed = JSON.parse(content);
        if (!object(parsed)) { invalidFiles++; continue; }
        const env = Object.fromEntries(Object.entries(parsed).filter(([key, value]) => ENV_KEYS.has(key) && typeof value === "string")
          .map(([key, value]) => [key, String(value).slice(0, 512)]));
        files.set(name, JSON.stringify(redactDiagnosticData(env, mode)));
      } else if (name.endsWith(".jsonl")) {
        const rows = [];
        for (const line of content.split("\n").filter(line => line.trim())) {
          let row;
          try { row = JSON.parse(line); } catch { omittedRecords++; continue; }
          if (!object(row) || time(row.ts) === null || !Number.isSafeInteger(row.seq) || row.seq < 0 ||
              typeof row.cat !== "string" || typeof row.event !== "string" || typeof row.severity !== "string" || !object(row.data)) {
            omittedRecords++; continue;
          }
          const cleaned = redactEvents([{ ...row, cat: safeText(row.cat, 64), event: safeText(row.event, 120),
            severity: ["debug", "info", "warn", "error"].includes(row.severity) ? row.severity : "debug" }], { mode })[0];
          rows.push(JSON.stringify({ ...cleaned, timeBasis: "client_clock" }));
        }
        files.set(name, rows.join("\n") + (rows.length ? "\n" : ""));
      } else {
        const parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) { invalidFiles++; continue; }
        const rows = [];
        for (const row of parsed) {
          if (!object(row) || time(row.ts) === null || typeof row.cat !== "string" || typeof row.msg !== "string" ||
              !["log", "debug", "info", "warn", "error"].includes(row.level)) { omittedRecords++; continue; }
          rows.push({ ts: row.ts, cat: safeText(row.cat, 64), level: row.level,
            msg: redactDiagnosticData({ msg: row.msg }, mode).msg });
        }
        files.set(name, JSON.stringify(rows));
      }
    } catch { invalidFiles++; }
  }
  const prior = object(doc.priorSession) ? doc.priorSession : {};
  return { files, metadata: {
    status: omittedRecords || invalidFiles ? "capped" : "ok", capturedAtMs: time(doc.capturedAtMs),
    timeBasis: "client_clock", omittedRecords, invalidFiles,
    priorSession: {
      status: ["ok", "capped", "missing", "stale"].includes(prior.status) ? prior.status : "unknown",
      sessionId: safeText(prior.sessionId), appVersion: safeText(prior.appVersion, 64),
      events: count(prior.events), evicted: count(prior.evicted), ringCapped: prior.ringCapped === true,
      unclean: typeof prior.unclean === "boolean" ? prior.unclean : null,
    },
  } };
}

module.exports = { parseClientReportDiagnostics, CLIENT_DIAGNOSTICS_MAX_BYTES, CLIENT_DIAGNOSTICS_FILES };
