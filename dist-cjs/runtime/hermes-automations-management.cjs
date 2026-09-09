const HERMES_AUTOMATION_READS = new Set(["automations.options", "automations.read", "automations.preview", "automations.receipt"]);
const HERMES_AUTOMATION_OPERATIONS = new Set([...HERMES_AUTOMATION_READS, "automations.create", "automations.update", "automations.delete", "automations.cancel"]);
const token = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 500) => typeof v === "string" && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) ? v : "";
const fieldNames = ["name", "prompt", "schedule", "deliver", "model", "provider", "enabled_toolsets", "context_from"];
function fields(raw) {
  if (!object(raw) || Object.keys(raw).some(k => !fieldNames.includes(k))) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["enabled_toolsets", "context_from"].includes(key)) {
      if (value === null) out[key] = null;
      else if (Array.isArray(value) && value.length <= 100 && value.every(v => text(v, 160))) out[key] = [...value];
      else return undefined;
    } else if (value === null) out[key] = null;
    else if (typeof value === "string" && text(value, key === "prompt" ? 16000 : 500) === value) out[key] = value;
    else return undefined;
  }
  return out;
}
function automationsRequest(operation, raw) {
  if (!HERMES_AUTOMATION_OPERATIONS.has(operation) || !object(raw)) return undefined;
  const allowed = operation === "automations.options" ? [] : operation === "automations.read" ? ["jobId"] :
    operation === "automations.receipt" ? ["operationId"] : operation === "automations.preview" ? ["jobId", "revision", "fields", "template", "templateValues"] :
    ["operationId", "producedAt", "expiresAt", ...(operation === "automations.create" ? ["fields", "template", "templateValues", "reviewHash"] : operation === "automations.update" ? ["jobId", "revision", "fields", "reviewHash"] : ["jobId", "revision"])];
  if (Object.keys(raw).some(k => !allowed.includes(k))) return undefined;
  for (const key of ["jobId", "operationId", "template"]) if (key in raw && !token(raw[key])) return undefined;
  if ("revision" in raw && !/^[a-f0-9]{64}$/.test(raw.revision)) return undefined;
  if (["automations.create", "automations.update"].includes(operation) && !/^[a-f0-9]{64}$/.test(raw.reviewHash)) return undefined;
  if (operation === "automations.read" && !token(raw.jobId) || operation === "automations.receipt" && !token(raw.operationId)) return undefined;
  if ("fields" in raw && fields(raw.fields) === undefined) return undefined;
  if ("templateValues" in raw && (!object(raw.templateValues) || Object.keys(raw.templateValues).length > 100 ||
      Object.entries(raw.templateValues).some(([k, v]) => !token(k) || !(typeof v === "number" && Number.isFinite(v) || typeof v === "string" && text(v, 16000) === v)))) return undefined;
  if (!HERMES_AUTOMATION_READS.has(operation)) {
    if (!token(raw.operationId) || !Number.isFinite(raw.producedAt) || !Number.isFinite(raw.expiresAt) || raw.producedAt > Date.now() + 1000 ||
        raw.expiresAt < Date.now() || raw.expiresAt <= raw.producedAt || raw.expiresAt - raw.producedAt > 15000) return undefined;
    if (["automations.update", "automations.delete"].includes(operation) && (!token(raw.jobId) || !/^[a-f0-9]{64}$/.test(raw.revision))) return undefined;
  }
  return { ...raw };
}
function job(raw) {
  if (!object(raw) || !token(raw.id) || !/^[a-f0-9]{64}$/.test(raw.revision) || !fields(raw.fields)) return null;
  return { id: raw.id, revision: raw.revision, fields: fields(raw.fields), skills: Array.isArray(raw.skills) ? raw.skills.slice(0, 100).map((v) => text(v, 160)).filter(Boolean) : [],
    nextRunAt: text(raw.nextRunAt), timezone: text(raw.timezone), reviewHash: text(raw.reviewHash), failureDestination: "same_as_delivery" };
}
function automationsResult(raw) {
  if (!object(raw)) return undefined;
  const out = {};
  if (raw.job) out.job = job(raw.job);
  if (raw.preview) {
    if (!/^[a-f0-9]{64}$/.test(raw.preview.reviewHash) || !job(raw.preview)) return undefined;
    out.preview = job(raw.preview);
  }
  if (raw.options) {
    const o = raw.options;
    out.options = { timezone: text(o.timezone), failureDestination: "same_as_delivery",
      destinations: (Array.isArray(o.destinations) ? o.destinations : []).slice(0, 100).map((d) => ({ id: text(d.id), name: text(d.name), available: d.available === true })),
      advanced: (Array.isArray(o.advanced) ? o.advanced : []).filter((d) => ["model", "provider", "enabled_toolsets", "context_from"].includes(d.field)).map((d) => ({ field: d.field, supported: d.supported === true })),
      templates: (Array.isArray(o.templates) ? o.templates : []).slice(0, 100).filter((t) => token(t.key)).map((t) => ({ key: t.key, title: text(t.title), description: text(t.description, 4000),
        fields: (Array.isArray(t.fields) ? t.fields : []).slice(0, 100).filter((f) => token(f.name)).map((f) => ({ name: f.name, type: text(f.type), label: text(f.label),
          default: typeof f.default === "number" && Number.isFinite(f.default) ? String(f.default) : text(f.default, 16000), optional: f.optional === true, strict: f.strict === true, help: text(f.help, 4000),
          options: (Array.isArray(f.options) ? f.options : []).slice(0, 100).map((v) => text(String(v))) })) })) };
  }
  if (raw.receipt) {
    const r = raw.receipt;
    if (!token(r.operationId) || r.job && r.job.id !== r.jobId) return undefined;
    if (!["not_found", "cancelled"].includes(r.state) && !token(r.jobId)) return undefined;
    if (r.job && !job(r.job)) return undefined;
    out.receipt = { operationId: r.operationId, jobId: text(r.jobId), job: job(r.job),
      state: ["not_found", "missing_job", "cancelled", "reserved", "rejected", "saved", "deleted", "stale_edit"].includes(r.state) ? r.state : "unknown",
      registration: ["registered", "failed", "not_attempted"].includes(r.registration) ? r.registration : "unknown",
      jobPresence: ["present", "removed"].includes(r.jobPresence) ? r.jobPresence : "unknown" };
  }
  return out;
}

module.exports = { HERMES_AUTOMATION_OPERATIONS, HERMES_AUTOMATION_READS, automationsRequest, automationsResult };
