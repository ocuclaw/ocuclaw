const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = { emoji: false, pace: false };
const STORE_FILENAME = "ocuclaw-display-toggles.json";

function createDisplayToggleTracker(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 200;
  const statePath =
    typeof opts.stateDir === "string" && opts.stateDir.trim()
      ? path.join(opts.stateDir.trim(), STORE_FILENAME)
      : null;

  const byKey = new Map();

  function norm(v) {
    return { emoji: !!(v && v.emoji), pace: !!(v && v.pace) };
  }

  function load() {
    if (!statePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (parsed && parsed.entries && typeof parsed.entries === "object") {
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (v && v.start) {
            const start = norm(v.start);

            byKey.set(k, { start, current: { ...start } });
          }
        }
      }
    } catch (_e) {

    }
  }

  function persist() {
    if (!statePath) return;
    try {
      const entries = {};
      for (const [k, v] of byKey.entries()) entries[k] = { start: v.start };
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (_e) {

    }
  }

  function evictIfNeeded() {
    while (byKey.size > limit) {
      const oldest = byKey.keys().next().value;
      if (oldest === undefined) break;
      byKey.delete(oldest);
    }
  }

  load();

  return {
    record(sessionKey, states) {
      const cur = norm(states);
      const existing = byKey.get(sessionKey);
      if (!existing) {
        byKey.set(sessionKey, { start: cur, current: cur });
        evictIfNeeded();
        persist();
        return;
      }
      existing.current = cur;
    },
    getStart(sessionKey) {
      const e = byKey.get(sessionKey);
      return e ? { ...e.start } : { ...DEFAULTS };
    },
    getCurrent(sessionKey) {
      const e = byKey.get(sessionKey);
      return e ? { ...e.current } : { ...DEFAULTS };
    },
    clear(sessionKey) {
      if (byKey.delete(sessionKey)) persist();
    },
  };
}

module.exports = { createDisplayToggleTracker };
