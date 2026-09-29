function sanitizeVersionMismatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!['plugin_too_old', 'client_too_old', 'version_unverified'].includes(raw.kind)) return null;
  if (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0) return null;
  const token = (value) => typeof value === 'string' && /^[A-Za-z0-9._+-]{1,64}$/.test(value) ? value : '';
  return { kind: raw.kind, required: token(raw.required), actual: token(raw.actual),
    backendKind: ['hermes', 'openclaw'].includes(raw.backendKind) ? raw.backendKind : 'unknown', atMs: raw.atMs };
}

function versionMismatchRow(raw) {
  const verdict = sanitizeVersionMismatch(raw);
  return {
    reportVersionMismatchKind: verdict?.kind || '',
    reportRequiredVersion: verdict?.required || '',
    reportActualPluginVersion: verdict?.actual || '',
    reportBackendKind: verdict?.backendKind || '',
    reportVersionMismatchAtMs: verdict?.atMs ?? '',
  };
}

function normalizeMismatchRow(row) {
  return versionMismatchRow({ kind: row?.reportVersionMismatchKind, required: row?.reportRequiredVersion,
    actual: row?.reportActualPluginVersion, backendKind: row?.reportBackendKind,
    atMs: row?.reportVersionMismatchAtMs === '' ? null : Number(row?.reportVersionMismatchAtMs) });
}

module.exports = { sanitizeVersionMismatch, versionMismatchRow, normalizeMismatchRow };
