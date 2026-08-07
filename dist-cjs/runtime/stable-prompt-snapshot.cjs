const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STORE_FILENAME = "ocuclaw-stable-prompts.json";
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

function createStablePromptSnapshotStore(opts = {}) {
  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : () => Date.now();
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const emitDebug = typeof opts.emitDebug === "function" ? opts.emitDebug : () => {};
  const statePath =
    typeof opts.stateDir === "string" && opts.stateDir.trim()
      ? path.join(opts.stateDir.trim(), STORE_FILENAME)
      : null;

  const byKey = new Map();

  function load() {
    if (!statePath) return;
    try {
      const raw = fs.readFileSync(statePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.entries && typeof parsed.entries === "object") {
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (v && typeof v.prompt === "string" && typeof v.sessionId === "string") {
            byKey.set(k, {
              sessionId: v.sessionId,
              prompt: v.prompt,
              hash: typeof v.hash === "string" ? v.hash : hashText(v.prompt),
              touchedMs: Number.isFinite(v.touchedMs) ? v.touchedMs : nowMs(),
            });
          }
        }
      }
    } catch (_err) {

    }
  }

  function persist() {
    if (!statePath) return;
    try {
      const entries = {};
      for (const [k, v] of byKey.entries()) entries[k] = v;
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      fs.renameSync(tmp, statePath);
    } catch (err) {
      emitDebug("relay.session", "stable_prompt_persist_failed", "warn", {}, () => ({
        message: err && err.message ? err.message : String(err),
      }));
    }
  }

  function normSessionId(sessionId) {
    return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "";
  }

  load();

  return {

    getOrCreate(sessionKey, sessionId, computeFn) {
      const sid = normSessionId(sessionId);
      const existing = byKey.get(sessionKey);
      if (existing && existing.sessionId === sid) {
        existing.touchedMs = nowMs();
        return existing.prompt;
      }
      const prompt = String(computeFn());
      const record = { sessionId: sid, prompt, hash: hashText(prompt), touchedMs: nowMs() };
      byKey.set(sessionKey, record);
      persist();
      emitDebug("relay.session", "stable_prompt_resolved", "info", { sessionKey }, () => ({
        sessionId: sid, chars: prompt.length, hash: record.hash,
      }));
      return prompt;
    },

    wouldChurn(sessionKey, sessionId, candidate) {
      const existing = byKey.get(sessionKey);
      if (!existing || existing.sessionId !== normSessionId(sessionId)) return false;
      return existing.hash !== hashText(String(candidate));
    },

    evict(sessionKey) {
      if (byKey.delete(sessionKey)) persist();
    },

    sweep() {
      const cutoff = nowMs() - ttlMs;
      let changed = false;
      for (const [k, v] of byKey.entries()) {
        if (v.touchedMs < cutoff) { byKey.delete(k); changed = true; }
      }
      if (changed) persist();
    },

    _size() { return byKey.size; },
  };
}

module.exports = { createStablePromptSnapshotStore };
