const { domainToUnicode } = require("node:url");
const { createLiveuiLibrary, liveuiLibraryDigest } = require("./glasses-ui-library.cjs");

const GRANTS_SCHEMA_VERSION = 1;
const GRANTS_FILENAME = "network-grants-v1.json";
const DOCUMENT_KEYS = new Set(["version", "granted", "denied", "pending", "digest"]);

function normalizeGrantHost(input) {
  if (typeof input !== "string") return { ok: false, code: "grant_invalid_host" };
  const host = input.trim().toLowerCase();
  if (
    !host ||
    host.length > 253 ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    host.includes("..") ||
    host.includes("://") ||
    /\s/.test(host) ||
    host.includes("[") ||
    host.includes("]") ||
    !/^[a-z0-9.-]+$/.test(host)
  ) {
    return { ok: false, code: "grant_invalid_host" };
  }
  const labels = host.split(".");
  if (labels.some((label) => !label || label.length > 63)) {
    return { ok: false, code: "grant_invalid_host" };
  }
  const punycode = labels.some((label) => label.startsWith("xn--"));
  return {
    ok: true,
    host,
    punycode,
    unicodeHost: punycode ? domainToUnicode(host) : null,
  };
}

function emptyDocumentInput() {
  return {
    version: GRANTS_SCHEMA_VERSION,
    granted: [],
    denied: [],
    pending: [],
  };
}

function validatesDocumentShape(record) {
  return !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).every((key) => DOCUMENT_KEYS.has(key)) &&
    record.version === GRANTS_SCHEMA_VERSION &&
    Array.isArray(record.granted) &&
    Array.isArray(record.denied) &&
    Array.isArray(record.pending) &&
    typeof record.digest === "string" &&
    !!record.digest;
}

function normalizeTimedHostRow(row, timestampKey) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const normalized = normalizeGrantHost(row.host);
  if (!normalized.ok || typeof row[timestampKey] !== "string" || !row[timestampKey]) return null;
  return { host: normalized.host, [timestampKey]: row[timestampKey] };
}

function normalizePendingRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const normalized = normalizeGrantHost(row.host);
  if (
    !normalized.ok ||
    typeof row.method !== "string" ||
    !row.method ||
    typeof row.hasHeaders !== "boolean" ||
    typeof row.hasBody !== "boolean" ||
    typeof row.requestedAt !== "string" ||
    !row.requestedAt
  ) return null;
  return {
    host: normalized.host,
    method: row.method,
    hasHeaders: row.hasHeaders,
    hasBody: row.hasBody,
    punycode: normalized.punycode,
    unicodeHost: normalized.unicodeHost,
    requestedAt: row.requestedAt,
  };
}

function uniqueRows(rows, normalize) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const normalized = normalize(row);
    if (!normalized || seen.has(normalized.host)) continue;
    seen.add(normalized.host);
    output.push(normalized);
  }
  return output;
}

function copyState(state) {
  return {
    granted: state.granted.map((row) => ({ ...row })),
    denied: state.denied.map((row) => ({ ...row })),
    pending: state.pending.map((row) => ({ ...row })),
    digest: state.digest,
    grantsInvalid: state.grantsInvalid,
  };
}

function createLiveuiGrantsStore(opts) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const maxPending = Number.isSafeInteger(opts.maxPending) && opts.maxPending >= 0
    ? opts.maxPending
    : 5;
  const cacheMs = Number.isFinite(opts.cacheMs) && opts.cacheMs >= 0
    ? opts.cacheMs
    : 1_000;
  const library = createLiveuiLibrary({ libraryDir: opts.dir });
  const emptyInput = emptyDocumentInput();
  const documentOptions = {
    defaultDigestInput: emptyInput,
    validateDocument: validatesDocumentShape,
  };

  let cached = null;
  let cachedAtMs = 0;

  function invalidState(reason) {
    return {
      granted: [],
      denied: [],
      pending: [],
      digest: null,
      grantsInvalid: typeof reason === "string" && reason
        ? reason
        : "library_document_malformed",
    };
  }

  function projectRecord(record, virtual) {
    const denied = uniqueRows(
      record.denied,
      (row) => normalizeTimedHostRow(row, "deniedAt"),
    );
    const deniedHosts = new Set(denied.map((row) => row.host));

    const granted = uniqueRows(
      record.granted,
      (row) => normalizeTimedHostRow(row, "grantedAt"),
    ).filter((row) => !deniedHosts.has(row.host));
    const effectiveHosts = new Set([
      ...granted.map((row) => row.host),
      ...deniedHosts,
    ]);
    const pending = uniqueRows(record.pending, normalizePendingRow)
      .filter((row) => !effectiveHosts.has(row.host));
    return {
      state: {
        granted,
        denied,
        pending,
        digest: virtual ? null : record.digest,
        grantsInvalid: null,
      },

      casDigest: record.digest,
    };
  }

  function loadInternal(force = false) {
    const nowMs = now();
    if (!force && cached && nowMs - cachedAtMs < cacheMs) return cached;
    const loaded = library.loadDocument(GRANTS_FILENAME, documentOptions);
    cached = loaded.status === "accepted"
      ? projectRecord(loaded.record, loaded.virtual === true)
      : { state: invalidState(loaded.reason), casDigest: null };
    cachedAtMs = nowMs;
    return cached;
  }

  function cacheSavedRecord(record) {
    cached = projectRecord(record, false);
    cachedAtMs = now();
    return cached;
  }

  function saveState(state, expectedDigest) {
    const digestInput = {
      version: GRANTS_SCHEMA_VERSION,
      granted: state.granted,
      denied: state.denied,
      pending: state.pending,
    };
    try {
      const saved = library.saveDocument(GRANTS_FILENAME, digestInput, {
        ...documentOptions,
        expectedDigest,
      });
      if (saved.status === "saved") {
        return { ok: true, loaded: cacheSavedRecord(saved.record) };
      }
      if (saved.code === "library_conflict") {
        cached = null;
        return { ok: false, conflict: true };
      }
      return { ok: false, conflict: false };
    } catch (_) {
      return { ok: false, conflict: false };
    }
  }

  function load() {
    return copyState(loadInternal().state);
  }

  function isGranted(host) {
    const normalized = normalizeGrantHost(host);
    if (!normalized.ok) return false;
    const state = loadInternal().state;
    return state.grantsInvalid === null &&
      state.granted.some((row) => row.host === normalized.host);
  }

  function isDenied(host) {
    const normalized = normalizeGrantHost(host);
    if (!normalized.ok) return false;
    const state = loadInternal().state;
    return state.grantsInvalid === null &&
      state.denied.some((row) => row.host === normalized.host);
  }

  function filePending(req) {
    const normalized = normalizeGrantHost(req && req.host);
    if (!normalized.ok) return normalized;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = loadInternal(attempt > 0);
      const state = current.state;
      if (state.grantsInvalid) return { ok: false, code: "grants_invalid" };
      if (state.pending.some((row) => row.host === normalized.host)) {
        return { ok: true, filed: false };
      }
      if (
        state.granted.some((row) => row.host === normalized.host) ||
        state.denied.some((row) => row.host === normalized.host)
      ) {
        return { ok: false, code: "grant_not_pending" };
      }
      if (state.pending.length >= maxPending) {
        return { ok: false, code: "grant_limit" };
      }
      const next = {
        ...copyState(state),
        pending: [
          ...state.pending.map((row) => ({ ...row })),
          {
            host: normalized.host,
            method: req.method,
            hasHeaders: req.hasHeaders,
            hasBody: req.hasBody,
            punycode: normalized.punycode,
            unicodeHost: normalized.unicodeHost,
            requestedAt: new Date(now()).toISOString(),
          },
        ],
      };
      const saved = saveState(next, current.casDigest);
      if (saved.ok) return { ok: true, filed: true };
      if (!saved.conflict) return { ok: false, code: "grants_write_failed" };
    }
    return { ok: false, code: "grants_write_failed" };
  }

  function apply(intent) {
    const current = loadInternal();
    const state = current.state;
    if (state.grantsInvalid) return { ok: false, code: "grants_invalid" };
    const normalized = normalizeGrantHost(intent && intent.host);
    if (!normalized.ok) return normalized;
    if (!Object.prototype.hasOwnProperty.call(intent, "baseDigest")) {
      return { ok: false, code: "grant_base_required" };
    }
    if (intent.baseDigest !== state.digest) {
      return { ok: false, code: "grant_base_invalid" };
    }

    const timestamp = new Date(now()).toISOString();
    const next = copyState(state);
    let removedHost;
    if (intent.action === "allow" || intent.action === "deny") {
      const pendingIndex = next.pending.findIndex((row) => row.host === normalized.host);
      if (pendingIndex < 0) return { ok: false, code: "grant_not_pending" };
      next.pending.splice(pendingIndex, 1);
      next.granted = next.granted.filter((row) => row.host !== normalized.host);
      next.denied = next.denied.filter((row) => row.host !== normalized.host);
      if (intent.action === "allow") {
        next.granted.push({ host: normalized.host, grantedAt: timestamp });
      } else {
        next.denied.push({ host: normalized.host, deniedAt: timestamp });
      }
    } else if (intent.action === "remove") {
      const wasGranted = next.granted.some((row) => row.host === normalized.host);
      const wasDenied = next.denied.some((row) => row.host === normalized.host);
      if (!wasGranted && !wasDenied) {
        return { ok: false, code: "grant_not_found" };
      }
      next.granted = next.granted.filter((row) => row.host !== normalized.host);
      next.denied = next.denied.filter((row) => row.host !== normalized.host);
      removedHost = normalized.host;
    } else {
      return { ok: false, code: "grant_not_found" };
    }

    const saved = saveState(next, current.casDigest);
    if (!saved.ok) {
      return {
        ok: false,
        code: saved.conflict ? "grant_base_invalid" : "grants_write_failed",
      };
    }
    return {
      ok: true,
      state: copyState(saved.loaded.state),
      ...(removedHost ? { removedHost } : {}),
    };
  }

  return { load, isGranted, isDenied, filePending, apply };
}

module.exports = { normalizeGrantHost, createLiveuiGrantsStore };
