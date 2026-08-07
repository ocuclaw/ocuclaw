const fs = require("node:fs");
const path = require("node:path");
const { parseEtSessionKey } = require("./session-key.cjs");

const CACHE_FILE = "even-terminal-transcript-cache.json";
const CACHE_VERSION = 1;
const DEFAULT_MAX_SNIPPETS = 50;
const DEFAULT_CONTEXT_CHARS = 60;

function normalizeStateDir(stateDir) {
  if (typeof stateDir !== "string") return null;
  const trimmed = stateDir.trim();
  return trimmed ? trimmed : null;
}

function cachePathFor(stateDir) {
  const normalized = normalizeStateDir(stateDir);
  return normalized ? path.join(normalized, CACHE_FILE) : null;
}

function normalizeText(value) {
  if (typeof value === "string") return value.trim();
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizeRole(value) {
  return value === "assistant" ? "assistant" : "user";
}

function normalizeHistoryRows(rows) {
  if (!Array.isArray(rows)) return [];
  const normalized = [];
  let ordinal = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const text = normalizeText(row.content ?? row.text);
    if (!text) continue;
    normalized.push({
      role: normalizeRole(row.role),
      text,
      ordinal: ordinal++,
    });
  }
  return normalized;
}

function normalizeHistoryResult(result) {
  if (Array.isArray(result)) {
    return { rows: normalizeHistoryRows(result), truncated: false };
  }
  if (result && typeof result === "object") {
    return {
      rows: normalizeHistoryRows(result.rows),
      truncated: result.truncated === true,
    };
  }
  return { rows: [], truncated: false };
}

function normalizeSessionRow(row) {
  if (!row || typeof row !== "object") return null;
  const key = typeof row.key === "string" ? row.key.trim() : "";
  const parsed = parseEtSessionKey(key);
  if (!parsed) return null;
  const updatedAt = Number.isFinite(row.updatedAt) ? Math.floor(row.updatedAt) : 0;
  return {
    key,
    provider: parsed.provider,
    sessionId: parsed.sessionId,
    updatedAt,
    title: normalizeText(row.title || row.firstUserMessage || row.preview),
  };
}

function entryNeedsHydration(entry) {
  return !entry || entry.needsHydration === true || !Array.isArray(entry.rows);
}

function loadCache(cachePath) {
  if (!cachePath) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (!parsed || parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) {
      return new Map();
    }
    const entries = new Map();
    for (const raw of parsed.entries) {
      if (!raw || typeof raw !== "object") continue;
      const key = typeof raw.key === "string" ? raw.key : "";
      const parsedKey = parseEtSessionKey(key);
      if (!parsedKey) continue;
      entries.set(key, {
        key,
        provider: parsedKey.provider,
        sessionId: parsedKey.sessionId,
        sourceUpdatedAt: Number.isFinite(raw.sourceUpdatedAt)
          ? Math.floor(raw.sourceUpdatedAt)
          : 0,
        title: normalizeText(raw.title),
        rows: normalizeHistoryRows(raw.rows),
        truncated: raw.truncated === true,
        hydratedAtMs: Number.isFinite(raw.hydratedAtMs)
          ? Math.floor(raw.hydratedAtMs)
          : 0,
        needsHydration: false,
        inFlight: null,
        error: null,
      });
    }
    return entries;
  } catch {
    return new Map();
  }
}

function writeCache(cachePath, entries) {
  if (!cachePath) return;
  const serializable = {
    version: CACHE_VERSION,
    entries: [...entries.values()]
      .filter((entry) => Array.isArray(entry.rows))
      .map((entry) => ({
        key: entry.key,
        provider: entry.provider,
        sessionId: entry.sessionId,
        sourceUpdatedAt: entry.sourceUpdatedAt,
        title: entry.title,
        rows: entry.rows,
        truncated: entry.truncated === true,
        hydratedAtMs: entry.hydratedAtMs,
      })),
  };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(serializable), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(cachePath, 0o600);
    } catch {

    }
  } catch {

  }
}

function buildSnippets(entries, query, opts = {}) {
  const needle = normalizeText(query).toLowerCase();
  if (!needle) return { snippets: [], truncated: false };
  const maxSnippets = Number.isFinite(opts.maxSnippets)
    ? Math.max(1, Math.floor(opts.maxSnippets))
    : DEFAULT_MAX_SNIPPETS;
  const contextChars = Number.isFinite(opts.contextChars)
    ? Math.max(0, Math.floor(opts.contextChars))
    : DEFAULT_CONTEXT_CHARS;
  const snippets = [];
  let truncated = false;
  const sorted = [...entries.values()].sort(
    (left, right) => (right.sourceUpdatedAt || 0) - (left.sourceUpdatedAt || 0),
  );
  for (const entry of sorted) {
    if (snippets.length >= maxSnippets) {
      truncated = true;
      break;
    }
    if (entry.truncated === true) {
      truncated = true;
    }
    const rows = Array.isArray(entry.rows) ? entry.rows : [];
    for (const row of rows) {
      if (snippets.length >= maxSnippets) {
        truncated = true;
        break;
      }
      const text = typeof row.text === "string" ? row.text : "";
      if (!text) continue;
      const lower = text.toLowerCase();
      const idx = lower.indexOf(needle);
      if (idx < 0) continue;
      const matchEnd = idx + needle.length;
      snippets.push({
        sessionKey: entry.key,
        role: normalizeRole(row.role),
        updatedAtMs: entry.sourceUpdatedAt || 0,
        before: text.slice(Math.max(0, idx - contextChars), idx),
        match: text.slice(idx, matchEnd),
        after: text.slice(matchEnd, Math.min(text.length, matchEnd + contextChars)),
      });
    }
  }
  return { snippets, truncated };
}

function createTerminalTranscriptCache(opts = {}) {
  const cachePath = cachePathFor(opts.stateDir);
  const historyReader =
    typeof opts.historyReader === "function" ? opts.historyReader : async () => [];
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const logger = opts.logger && typeof opts.logger === "object" ? opts.logger : null;
  const entries = loadCache(cachePath);
  let lastHydration = null;
  let dirty = false;

  function persistIfDirty() {
    if (!dirty) return;
    dirty = false;
    writeCache(cachePath, entries);
  }

  function reconcileSessions(rows, targetByKey = null) {
    const normalized = [];
    const visibleKeys = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const session = normalizeSessionRow(row);
      if (!session) continue;
      normalized.push(session);
      visibleKeys.add(session.key);
    }

    for (const key of [...entries.keys()]) {
      if (!visibleKeys.has(key)) {
        entries.delete(key);
        dirty = true;
      }
    }

    for (const session of normalized) {
      const existing = entries.get(session.key);
      const target = resolveTarget(targetByKey, session);
      if (!existing) {
        entries.set(session.key, {
          key: session.key,
          provider: session.provider,
          sessionId: session.sessionId,
          sourceUpdatedAt: session.updatedAt,
          title: session.title,
          rows: null,
          truncated: false,
          hydratedAtMs: 0,
          needsHydration: true,
          inFlight: null,
          target,
          error: null,
        });
        dirty = true;
        continue;
      }
      existing.provider = session.provider;
      existing.sessionId = session.sessionId;
      existing.title = session.title;
      existing.target = target;
      if (existing.sourceUpdatedAt !== session.updatedAt) {
        existing.sourceUpdatedAt = session.updatedAt;
        existing.needsHydration = true;
        dirty = true;
      }
    }
    persistIfDirty();
  }

  function resolveTarget(targetByKey, session) {
    if (!targetByKey) return null;
    if (typeof targetByKey.get === "function") {
      return targetByKey.get(`${session.provider}:${session.sessionId}`) ||
        targetByKey.get(session.key) ||
        null;
    }
    if (typeof targetByKey === "object") {
      return targetByKey[`${session.provider}:${session.sessionId}`] ||
        targetByKey[session.key] ||
        null;
    }
    return null;
  }

  async function hydrateEntry(entry) {
    if (!entry || entry.inFlight) return entry ? entry.inFlight : Promise.resolve();
    entry.inFlight = Promise.resolve()
      .then(() => historyReader({
        key: entry.key,
        provider: entry.provider,
        sessionId: entry.sessionId,
        title: entry.title,
        updatedAt: entry.sourceUpdatedAt,
        target: entry.target || null,
      }))
      .then((result) => {
        const history = normalizeHistoryResult(result);
        entry.rows = history.rows;
        entry.truncated = history.truncated;
        entry.hydratedAtMs = Math.floor(now());
        entry.needsHydration = false;
        entry.error = null;
        dirty = true;
      })
      .catch((err) => {
        entry.error = err && err.message ? err.message : String(err);
        entry.needsHydration = false;
        if (logger && typeof logger.warn === "function") {
          logger.warn(`[even-terminal] transcript hydrate failed for ${entry.key}: ${entry.error}`);
        }
      })
      .finally(() => {
        entry.inFlight = null;
        persistIfDirty();
      });
    return entry.inFlight;
  }

  function refreshNeededEntries() {
    const needs = [...entries.values()].filter(entryNeedsHydration);
    if (needs.length === 0) {
      lastHydration = null;
      return null;
    }
    if (lastHydration) return lastHydration;
    lastHydration = (async () => {
      for (const entry of needs) {
        await hydrateEntry(entry);
      }
    })().finally(() => {
      lastHydration = null;
    });
    return lastHydration;
  }

  function search(query, searchOpts = {}) {
    const refreshPromise =
      searchOpts.skipRefresh === true ? null : refreshNeededEntries();
    const result = buildSnippets(entries, query, searchOpts);
    return {
      ...result,
      refreshing: !!refreshPromise,
      refreshPromise,
    };
  }

  function prewarm() {
    return refreshNeededEntries() || Promise.resolve();
  }

  return {
    reconcileSessions,
    search,
    prewarm,
    _entries: entries,
  };
}

module.exports = { createTerminalTranscriptCache };
