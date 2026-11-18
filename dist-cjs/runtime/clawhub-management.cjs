const CLAWHUB_SEARCHES = new Set(["clawhub.plugins.search", "clawhub.skills.search"]);
const CLAWHUB_DETAILS = new Set(["clawhub.plugins.detail", "clawhub.skills.detail"]);
const CLAWHUB_READS = new Set([...CLAWHUB_SEARCHES, ...CLAWHUB_DETAILS]);
const CLAWHUB_OPERATIONS = new Set([...CLAWHUB_READS, "clawhub.plugins.install", "clawhub.skills.install"]);

const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v     , limit        ) => typeof v === "string" && v.length <= limit && !/[\u0000-\u001f]/.test(v);
const ref = (v     ) => typeof v === "string" && /^[A-Za-z0-9@._:/+=-]{1,200}$/.test(v);
const version = (v     ) => typeof v === "string" && /^[A-Za-z0-9._+-]{0,64}$/.test(v);
const TRUST = new Set(["official", "verified", "community", "not_scanned"]);
const RESULT_KEYS = ["ref", "name", "summary", "version", "trust", "installed", "installable"];

const CLAWHUB_ERRORS                         = {
  invalid_request: "Review this install and confirm it again.",
  native_read_failed: "Could not search ClawHub through OpenClaw. Try again when connected.",
  outcome_unknown: "OpenClaw didn't confirm this install. Search again to see whether it happened.",
  rate_limited: "Too many changes in a minute. Wait a moment, then try again.",
  needs_review: "This plugin asks for extra permissions. Finish installing it in OpenClaw's dashboard.",
  blocked: "ClawHub or OpenClaw's security check blocked this package.",
  not_found: "ClawHub no longer lists this package or version. Search again.",
  incompatible: "This package doesn't work with this OpenClaw version.",
  already_installed: "This is already installed. Search again to see it.",
  managed_setting: "OpenClaw doesn't let this be installed from here.",
  install_failed: "OpenClaw couldn't install this package.",
  profile_not_served: "This agent is no longer served here. Pick another one.",
};

function clawhubRequest(op        , raw     )      {
  if (!CLAWHUB_OPERATIONS.has(op) || !record(raw)) return null;
  if (CLAWHUB_SEARCHES.has(op)) {
    if (Object.keys(raw).length !== 1 || !text(raw.query, 80) || !raw.query.trim() || raw.query !== raw.query.trim()) return null;
    return { query: raw.query };
  }
  if (CLAWHUB_DETAILS.has(op)) {
    if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, "ref") || !Object.hasOwn(raw, "version") || !ref(raw.ref) || !version(raw.version)) return null;
    return { ref: raw.ref, version: raw.version };
  }
  const keys = ["confirmed", "ref", "version"];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(k => !keys.includes(k))) return null;
  if (raw.confirmed !== true || !ref(raw.ref) || !version(raw.version)) return null;
  return { confirmed: true, ref: raw.ref, version: raw.version };
}

function searchResult(raw     , query        ) {
  if (!record(raw) || raw.query !== query || !Array.isArray(raw.results) || raw.results.length > 20) return null;
  const results        = [];
  for (const row of raw.results) {
    if (!record(row) || !ref(row.ref) || results.some(r => r.ref === row.ref) || !text(row.name, 160) || !row.name.trim() ||
      !text(row.summary, 240) || !version(row.version) || !TRUST.has(row.trust) ||
      typeof row.installed !== "boolean" || typeof row.installable !== "boolean") return null;
    results.push(Object.fromEntries(RESULT_KEYS.map(k => [k, row[k]])));
  }
  return { query, results };
}

function doneResult(raw     , request     ) {
  if (!record(raw) || raw.ref !== request?.ref || !["committed", "not_applied"].includes(raw.outcome) ||
    typeof raw.restartRequired !== "boolean" || typeof raw.warned !== "boolean") return null;
  return { ref: raw.ref, outcome: raw.outcome, restartRequired: raw.restartRequired, warned: raw.warned };
}

function detailResult(raw     , request     ) {
  if (!record(raw) || raw.ref !== request?.ref || raw.version !== request?.version ||
    typeof raw.description !== "string" || raw.description.length > 16_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw.description) ||
    !text(raw.publisher, 160) || typeof raw.descriptionTruncated !== "boolean") return null;
  const detail      = { ref: raw.ref, version: raw.version, description: raw.description,
    descriptionTruncated: raw.descriptionTruncated, publisher: raw.publisher };
  for (const key of ["downloads", "bookmarks", "installs", "updatedAt"]) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0 || (key === "updatedAt" && raw[key] > 8_640_000_000_000_000)) return null;
    detail[key] = raw[key];
  }
  return detail;
}

function clawhubManagementResult(identity     , raw     , backend = "OpenClaw")      {
  const op = identity.operation;
  const envelope = Object.fromEntries(["requestId", "operation", "scope", "profileId"].map(k => [k, identity[k]]));
  const read = CLAWHUB_READS.has(op);
  const key = CLAWHUB_SEARCHES.has(op) ? "search" : CLAWHUB_DETAILS.has(op) ? "detail" : "done";
  const body = key === "search" ? searchResult(raw.clawhub?.search, identity.clawhub?.query)
    : key === "detail" ? detailResult(raw.clawhub?.detail, identity.clawhub) : doneResult(raw.clawhub?.done, identity.clawhub);
  const onlyBody = record(raw.clawhub) && Object.keys(raw.clawhub).length === 1;
  if (raw.status === "ok" && body && onlyBody) {
    return { ...envelope, status: "ok", capabilities: [], clawhub: { [key]: body } };
  }
  if (raw.status === "unsupported") {
    return { ...envelope, status: "unsupported", capabilities: [], errorCode: "unsupported",
      errorMessage: `This ${backend} host does not support this operation. Update ${backend} and OcuClaw to a compatible version.` };
  }

  const known = raw.status === "error" && Object.hasOwn(CLAWHUB_ERRORS, raw.errorCode);
  const code = known ? raw.errorCode : read ? "native_read_failed" : "outcome_unknown";
  return { ...envelope, status: "error", capabilities: [], errorCode: code, errorMessage: CLAWHUB_ERRORS[code] };
}

module.exports = { CLAWHUB_READS, CLAWHUB_OPERATIONS, CLAWHUB_ERRORS, clawhubRequest, clawhubManagementResult };
