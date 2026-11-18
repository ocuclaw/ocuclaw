const MODELS_OPERATIONS = new Set(["models.read", "models.update", "models.authOrder",
  "models.apiKey", "models.signInRefresh", "models.secretSet", "models.secretDelete"]);
const MODELS_READS = new Set(["models.read"]);
const KEY_OPERATIONS = new Set(["models.apiKey", "models.signInRefresh", "models.secretSet", "models.secretDelete"]);
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const FIELDS = ["model", "fallbacks", "utility", "image", "pdf", "voice", "decision"];
const STATUSES = ["ok", "expiring", "expired", "missing", "static", "unknown"];
const PROFILE_TYPES = ["oauth", "token", "api_key", "unknown"];
const record = (v     ) => v && typeof v === "object" && !Array.isArray(v);
const text = (v     , max     ) => typeof v === "string" && v.length >= 1 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const ref = (v     ) => text(v, 200);
const revision = (v     ) => typeof v === "string" && /^[A-Za-z0-9_.:+/=-]{1,128}$/.test(v);
const distinct = (list     ) => new Set(list).size === list.length;

function validChange(field     , value     ) {
  if (value === null) return true;
  if (field === "fallbacks") return Array.isArray(value) && value.length <= 16 && value.every(ref) && distinct(value);
  if (field === "utility" && value === "") return true;
  return ref(value);
}

const secretValue = (v     , max     ) => text(v, max) && v.trim().length > 0;

function intent(raw     ) {
  return Number.isSafeInteger(raw.producedAtMs) && Number.isSafeInteger(raw.expiresAtMs) && raw.producedAtMs >= 0 &&
    raw.expiresAtMs > raw.producedAtMs && raw.expiresAtMs - raw.producedAtMs <= 30000 && raw.confirmed === true;
}

function keyRequest(op     , raw     ) {
  if (op === "models.signInRefresh") return raw == null || record(raw) && !Object.keys(raw).length ? {} : null;
  if (!record(raw) || !intent(raw)) return null;
  const when = { confirmed: true, producedAtMs: raw.producedAtMs, expiresAtMs: raw.expiresAtMs };
  const keys = Object.keys(raw).length;
  if (op === "models.apiKey") {
    return keys === 5 && text(raw.provider, 80) && secretValue(raw.apiKey, 4096) ? { provider: raw.provider, apiKey: raw.apiKey, ...when } : null;
  }
  if (typeof raw.name !== "string" || !SECRET_NAME.test(raw.name)) return null;
  if (op === "models.secretDelete") return keys === 4 ? { name: raw.name, ...when } : null;
  return keys === 5 && secretValue(raw.value, 8192) ? { name: raw.name, value: raw.value, ...when } : null;
}

function modelsRequest(op     , raw     )      {
  if (!MODELS_OPERATIONS.has(op)) return null;
  if (op === "models.read") return raw == null || record(raw) && !Object.keys(raw).length ? {} : null;
  if (KEY_OPERATIONS.has(op)) return keyRequest(op, raw);
  if (!record(raw) || !revision(raw.revision)) return null;
  if (op === "models.update") {
    if (Object.keys(raw).length !== 2 || !record(raw.changes)) return null;
    const fields = Object.keys(raw.changes);
    if (!fields.length || !fields.every(field => FIELDS.includes(field) && validChange(field, raw.changes[field]))) return null;
    const changes = Object.fromEntries(fields.map(field => [field, Array.isArray(raw.changes[field]) ? [...raw.changes[field]] : raw.changes[field]]));
    return { revision: raw.revision, changes };
  }
  if (Object.keys(raw).length !== 3 || !text(raw.provider, 80) || !Array.isArray(raw.profileIds) ||
      raw.profileIds.length < 1 || raw.profileIds.length > 16 || !raw.profileIds.every((id     ) => text(id, 160)) || !distinct(raw.profileIds)) return null;
  return { revision: raw.revision, provider: raw.provider, profileIds: [...raw.profileIds] };
}

function fieldRow(row     ) {
  if (!record(row) || !FIELDS.includes(row.id) || typeof row.restart !== "boolean") return null;
  if (typeof row.value !== "string" || row.value.length > 200 || /[\u0000-\u001f]/.test(row.value)) return null;
  if (row.id === "fallbacks" && row.value !== "") return null;
  const out      = { id: row.id, value: row.value, restart: row.restart };
  if (row.id === "utility") {
    if (typeof row.off !== "boolean" || row.off && row.value !== "") return null;
    out.off = row.off;
  }
  return out;
}

function providerRow(row     ) {
  if (!record(row) || !text(row.provider, 80) || !text(row.name, 80) || !STATUSES.includes(row.status) ||
      typeof row.orderEditable !== "boolean" || !Array.isArray(row.profiles) || row.profiles.length > 16) return null;
  const profiles        = [];
  for (const p of row.profiles) {
    if (!record(p) || !text(p.id, 160) || !PROFILE_TYPES.includes(p.type) || !STATUSES.includes(p.status) || profiles.some(q => q.id === p.id)) return null;
    profiles.push({ id: p.id, type: p.type, status: p.status });
  }
  if (row.orderEditable && profiles.length < 2) return null;
  const out      = { provider: row.provider, name: row.name, status: row.status, orderEditable: row.orderEditable, profiles };
  if (row.expiresAtMs !== undefined) {
    if (!Number.isSafeInteger(row.expiresAtMs) || row.expiresAtMs <= 0) return null;
    out.expiresAtMs = row.expiresAtMs;
  }
  return out;
}

function modelsSnapshot(raw     )      {
  if (!record(raw) || !revision(raw.revision) || typeof raw.writable !== "boolean" || typeof raw.orderWritable !== "boolean") return null;
  if (!Array.isArray(raw.fields) || raw.fields.length > FIELDS.length || !Array.isArray(raw.fallbacks) || raw.fallbacks.length > 16 ||
      !raw.fallbacks.every(ref) || !distinct(raw.fallbacks) || !Array.isArray(raw.providers) || raw.providers.length > 32) return null;
  const fields = raw.fields.map(fieldRow);
  if (fields.some((row     ) => !row)) return null;

  const order = fields.map((row     ) => FIELDS.indexOf(row.id));
  if (order.some((at     , i     ) => i > 0 && at <= order[i - 1])) return null;
  if (raw.fallbacks.length > 0 && !fields.some((row     ) => row.id === "fallbacks")) return null;
  const providers = raw.providers.map(providerRow);
  if (providers.some((row     ) => !row) || !distinct(providers.map((row     ) => row.provider))) return null;
  if (!raw.orderWritable && providers.some((row     ) => row.orderEditable)) return null;
  const keys = keysSnapshot(raw);
  if (!keys) return null;
  return { revision: raw.revision, writable: raw.writable, orderWritable: raw.orderWritable, fields, fallbacks: [...raw.fallbacks], providers, ...keys };
}

function keysSnapshot(raw     ) {
  const flags = ["keysWritable", "refreshable", "secretsReadable", "secretsWritable"];
  if (!flags.every(flag => typeof raw[flag] === "boolean") || !Array.isArray(raw.keyProviders) || raw.keyProviders.length > 64 ||
      !Array.isArray(raw.secrets) || raw.secrets.length > 128) return null;
  if (!raw.keysWritable && raw.keyProviders.length > 0 || !raw.secretsReadable && (raw.secretsWritable || raw.secrets.length > 0)) return null;
  const keyProviders        = [];
  for (const row of raw.keyProviders) {
    if (!record(row) || Object.keys(row).length !== 2 || !text(row.provider, 80) || !text(row.name, 80) ||
        keyProviders.some(p => p.provider === row.provider)) return null;
    keyProviders.push({ provider: row.provider, name: row.name });
  }
  const secrets        = [];
  for (const row of raw.secrets) {
    if (!record(row) || Object.keys(row).length !== 4 || typeof row.name !== "string" || !SECRET_NAME.test(row.name) ||
        !["secret", "env"].includes(row.kind) || !Number.isSafeInteger(row.updatedAtMs) || row.updatedAtMs < 0 ||
        typeof row.restricted !== "boolean" || secrets.some(s => s.name === row.name)) return null;
    secrets.push({ name: row.name, kind: row.kind, updatedAtMs: row.updatedAtMs, restricted: row.restricted });
  }
  return { keysWritable: raw.keysWritable, keyProviders, refreshable: raw.refreshable,
    secretsReadable: raw.secretsReadable, secretsWritable: raw.secretsWritable, secrets };
}

const errors                         = {
  invalid_request: "OpenClaw did not accept this model choice. Reload the page and pick again.",
  outcome_unknown: "OpenClaw may not have saved this. Reload the page to see what it holds now.",
  invalid_models_result: "OpenClaw sent model settings this app can't read. Reload the page.",
  intent_expired: "This confirmation expired before it was sent. Nothing was saved. Confirm again.",
};

const keyErrors                         = {
  invalid_request: "OpenClaw did not accept this. Reload the page and try again.",
  outcome_unknown: "OpenClaw may have saved this. Reload the page to check before you send it again.",
};

function modelsManagementResult(identity     , raw     , sharedErrors     )      {
  const envelope = Object.fromEntries(["requestId", "operation", "scope", "profileId"].map(k => [k, identity[k]]));
  const own = KEY_OPERATIONS.has(identity.operation) ? { ...errors, ...keyErrors } : errors;
  const failure = (code     ) => ({ ...envelope, status: code === "unsupported" ? "unsupported" : "error", capabilities: [], errorCode: code,
    errorMessage: code === "unsupported" ? "This OpenClaw can't manage models from here." : sharedErrors[code] || own[code] ||
      (code === "management_unavailable" ? "Could not read OpenClaw model settings. Refresh when connected." : own.outcome_unknown) });
  if (raw.status === "unsupported") return failure("unsupported");
  const write = !MODELS_READS.has(identity.operation);
  if (raw.status !== "ok") {
    const known = Object.hasOwn(sharedErrors, raw.errorCode) || ["invalid_request", "outcome_unknown", "intent_expired"].includes(raw.errorCode) ||
      raw.errorCode === "management_unavailable" && !write;
    return failure(known ? raw.errorCode : write ? "outcome_unknown" : "management_unavailable");
  }
  const models = modelsSnapshot(raw.models);
  if (!models) return failure(write ? "outcome_unknown" : "invalid_models_result");
  return { ...envelope, status: "ok", capabilities: [], models };
}

module.exports = { MODELS_OPERATIONS, MODELS_READS, modelsRequest, modelsSnapshot, modelsManagementResult };
