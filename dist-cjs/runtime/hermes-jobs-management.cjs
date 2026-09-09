const HERMES_JOB_OPERATIONS = new Set(["jobs.list", "jobs.history", "jobs.receipt", "jobs.pause", "jobs.resume", "jobs.run", "jobs.cancel"]);
const HERMES_JOB_READS = new Set(["jobs.list", "jobs.history", "jobs.receipt"]);
const token = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function jobsRequest(operation, raw) {
  if (!HERMES_JOB_OPERATIONS.has(operation)) return undefined;
  const p = raw ?? {};
  if (typeof p !== "object" || Array.isArray(p)) return undefined;
  const allowed = operation === "jobs.list" ? [] : operation === "jobs.history" ? ["jobId"] : operation === "jobs.receipt" ? ["operationId"] : ["jobId", "operationId", "producedAt", "expiresAt", "resumeAndRun"];
  if (Object.keys(p).some(k => !allowed.includes(k))) return undefined;
  for (const key of ["jobId", "operationId"]) if (key in p && !token(p[key])) return undefined;
  if (operation === "jobs.receipt" && !token(p.operationId)) return undefined;
  if (!HERMES_JOB_READS.has(operation)) {
    if (!token(p.jobId) || !token(p.operationId) || !Number.isFinite(p.producedAt) || !Number.isFinite(p.expiresAt) ||
        p.producedAt > Date.now() + 1000 || p.expiresAt < Date.now() || p.expiresAt <= p.producedAt || p.expiresAt - p.producedAt > 15000) return undefined;
    if ("resumeAndRun" in p && (operation !== "jobs.run" || typeof p.resumeAndRun !== "boolean")) return undefined;
  }
  return { ...p };
}
const text = (v) => typeof v === "string" && v.length <= 256 && !/[\u0000-\u001f]/.test(v) ? v : "";
const execution = (r) => r && typeof r === "object" ? {
  id: text(r.id), jobId: text(r.jobId), status: ["claimed", "running", "completed", "failed", "unknown"].includes(r.status) ? r.status : "unknown",
  delivery: ["failed", "delivered", "not_configured", "suppressed", "suppressed_acked"].includes(r.delivery) ? r.delivery : "unknown",
  startedAt: text(r.startedAt), finishedAt: text(r.finishedAt),
} : null;
const job = (r) => r && typeof r === "object" && token(r.id) ? {
  id: r.id, name: text(r.name), state: text(r.state), paused: r.paused === true,
  schedule: text(r.schedule), nextRunAt: text(r.nextRunAt), lastExecution: execution(r.lastExecution),
} : null;
function jobsResult(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  if (Array.isArray(raw.jobs)) out.jobs = raw.jobs.slice(0, 100).map(job).filter(Boolean);
  if (Array.isArray(raw.history)) out.history = raw.history.slice(0, 50).map(execution).filter(Boolean);
  if (raw.provider) out.provider = text(raw.provider);
  out.truncated = raw.truncated === true;
  if (raw.receipt && token(raw.receipt.operationId)) {
    const r = raw.receipt;
    if (r.execution && (!token(r.executionId) || r.execution.id !== r.executionId ||
        !token(r.jobId) || r.execution.jobId !== r.jobId)) return undefined;
    if (r.job && r.job.id !== r.jobId) return undefined;
    out.receipt = { operationId: r.operationId, jobId: text(r.jobId), executionId: text(r.executionId),
      state: ["not_found", "cancelled", "reserved", "rejected", "applied", "admitted"].includes(r.state) ? r.state : "unknown",
      jobPresence: ["present", "removed"].includes(r.jobPresence) ? r.jobPresence : "unknown",
      execution: execution(r.execution), job: job(r.job) };
  }
  return out;
}

module.exports = { HERMES_JOB_OPERATIONS, HERMES_JOB_READS, jobsRequest, jobsResult };
