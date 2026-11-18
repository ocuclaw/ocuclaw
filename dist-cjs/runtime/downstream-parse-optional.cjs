function parseOptionalTrimmedString(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function parseOptionalInteger(raw     ) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  return Number.isFinite(Number(raw)) ? Math.floor(Number(raw)) : null;
}

function parseOptionalBoolean(raw, fieldName) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a boolean`);
  }
  const normalized = raw.trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`${fieldName} must be a boolean`);
}

function parseOptionalPositiveNumber(raw, fieldName) {
  if (raw === undefined || raw === null) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return Math.floor(num);
}

function parseOptionalNonNegativeNumber(raw, fieldName) {
  if (raw === undefined || raw === null) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${fieldName} must be a non-negative number`);
  }
  return Math.floor(num);
}

function parseOptionalStringArray(raw, fieldName) {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }
  const values = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error(`${fieldName} must be an array of strings`);
    }
    const trimmed = entry.trim();
    if (trimmed) values.push(trimmed);
  }
  return values;
}

function parseOptionalPositiveInt(value) {
  if (value === undefined || value === null) return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.floor(num);
}

function parseEnvelopeOnly   (_msg         , payload   )    {
  return payload;
}

module.exports = { parseOptionalTrimmedString, parseOptionalInteger, parseOptionalBoolean, parseOptionalPositiveNumber, parseOptionalNonNegativeNumber, parseOptionalStringArray, parseOptionalPositiveInt, parseEnvelopeOnly };
