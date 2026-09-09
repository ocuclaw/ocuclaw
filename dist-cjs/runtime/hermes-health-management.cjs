const HEALTH_READS = new Set(["health.snapshot", "health.usage", "diagnostics.status"]);
const HEALTH_OPERATIONS = new Set([...HEALTH_READS, "diagnostics.start", "diagnostics.cancel"]);
const token = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(v);
const number = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const id = (v) => typeof v === "string" && /^[A-Za-z0-9_.:/@+ -]{1,160}$/.test(v);
const actions = {
  advisories: "Review native security advisories with the host administrator.",
  mcp: "Review configured MCP package versions and native advisories.",
  python: "Check the Hermes interpreter and environment on the host.",
  certificates: "Check host certificate configuration.",
  packages: "Review missing package dependencies on the host.",
  configuration: "Review the selected profile configuration on the host.",
  authentication: "Review provider authentication in the selected profile.",
  storage: "Check selected profile storage permissions and database health.",
  command: "Check the native Hermes CLI installation.",
  tools: "Review required tool availability for the selected profile.",
  connectivity: "Check configured provider credentials and connectivity.",
  skills: "Review the native Skills Hub configuration.",
  memory: "Review the configured native memory provider.",
  profiles: "Review native profile configuration on the host.",
  supervision: "Review native service supervision on the host.",
  service: "Review native gateway service status on the host.",
  native_check: "Review native diagnostic details on the host.",
};
function healthRequest(op, value) {
  const p = value ?? {};
  const keys = op === "health.snapshot" ? [] : op === "health.usage" ? ["periodDays"] :
    op === "diagnostics.status" ? ["operationId"] : ["operationId", "producedAt", "expiresAt", ...(op === "diagnostics.start" ? ["kind"] : [])];
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== keys.length || keys.some(key => !(key in p))) return undefined;
  if (keys.includes("operationId") && !token(p.operationId)) return undefined;
  if (op === "health.usage" && ![7, 30, 90].includes(p.periodDays)) return undefined;
  if (!HEALTH_READS.has(op) && (!number(p.producedAt) || !number(p.expiresAt) || p.producedAt > Date.now() + 1000 ||
      p.expiresAt <= Date.now() || p.expiresAt > p.producedAt + 15000)) return undefined;
  if (op === "diagnostics.start" && !["doctor", "security"].includes(p.kind)) return undefined;
  return Object.fromEntries(keys.map(key => [key, p[key]]));
}
function healthResult(raw) {
  if (!raw || typeof raw !== "object") throw new Error("Invalid health result");
  const result = {};
  if (raw.snapshot) {
    const row = raw.snapshot;
    if (!number(row.observedAt) || row.source !== "native_gateway" || row.gateway !== "responding" || row.provider !== "unknown") throw new Error("Invalid snapshot");
    result.snapshot = {observedAt: row.observedAt, source: row.source, gateway: row.gateway, provider: "unknown"};
    for (const key of ["providerFailures", "jobFailures", "diskFree"]) result.snapshot[key] = number(row[key]) ? row[key] : null;
  }
  if (raw.usage) {
    const row = raw.usage;
    if (!number(row.observedAt) || row.source !== "native_session_accounting" || row.window !== "session_start" || ![7, 30, 90].includes(row.periodDays) || !Array.isArray(row.models)) throw new Error("Invalid usage");
    const accounting = (r) => {
      const out = {};
      for (const key of ["input", "output", "records", "actualRecords", "estimatedRecords"]) {
        if (!number(r?.[key])) throw new Error("Invalid accounting");
        out[key] = r[key];
      }
      for (const key of ["actual", "estimated"]) {
        if (r[key] !== null && !number(r[key])) throw new Error("Invalid cost");
        out[key] = r[key];
      }
      if (out.actualRecords > out.records || out.estimatedRecords > out.records) throw new Error("Invalid coverage");
      return out;
    };
    result.usage = {observedAt: row.observedAt, source: row.source, window: row.window, periodDays: row.periodDays,
      auxiliary: row.auxiliary === "available" ? "available" : "unknown", truncated: row.truncated === true,
      totals: accounting(row.totals), models: row.models.slice(0, 100).map((r) => ({...accounting(r), model: id(r.model) ? r.model : "redacted-model"}))};
  }
  if (raw.receipt) {
    const row = raw.receipt;
    if (!token(row.operationId) || !["not_found", "reserved", "running", "completed", "partial", "cancelled", "unknown", "native_failed", "permission_denied", "timeout"].includes(row.state)) throw new Error("Invalid receipt");
    const receipt = {operationId: row.operationId, state: row.state, findings: []};
    for (const key of ["startedAt", "updatedAt", "deadlineSeconds", "checks"]) if (number(row[key])) receipt[key] = row[key];
    if (["doctor", "security", "unknown"].includes(row.kind)) receipt.kind = row.kind;
    if ([...Object.keys(actions), "starting", "admitted", "native_checks", "component_discovery", "advisory_lookup", "finished", "gateway_changed", "cancel_unconfirmed", "result_unavailable"].includes(row.phase)) receipt.phase = row.phase;
    if (["unknown", "native_reported_checks", "discovered_pinned_components", "advisory_details_incomplete"].includes(row.coverage)) receipt.coverage = row.coverage;
    receipt.truncated = row.truncated === true;
    for (const item of Array.isArray(row.findings) ? row.findings.slice(0, 64) : []) {
      const advisory = typeof item.code === "string" && /^(CVE|GHSA|PYSEC|GO|RUSTSEC|OSV|GSD|MAL)-[A-Za-z0-9-]{1,100}$/.test(item.code);
      if (!(Object.hasOwn(actions, item.code) || advisory) || !["ok", "warning", "error", "info", "critical", "high", "medium", "low", "unknown"].includes(item.severity) || !number(item.count)) continue;

      receipt.findings.push({code: item.code, severity: item.severity, count: item.count,
        nextStep: item.severity === "ok" ? "No action for these reported checks." :
          advisory ? "Review this advisory and affected installed dependencies with the host administrator." : actions[item.code]});
    }
    result.receipt = receipt;
  }
  if (!Object.keys(result).length) throw new Error("Empty health result");
  return result;
}

module.exports = { HEALTH_OPERATIONS, HEALTH_READS, healthRequest, healthResult };
