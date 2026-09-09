const fs = require("node:fs");
const path = require("node:path");

const MODEL_CONTEXT_WINDOW_CACHE_FILE = "ocuclaw-model-context-windows.json";

function normalizeStateDir(stateDir) {
  if (typeof stateDir !== "string") return null;
  const trimmed = stateDir.trim();
  return trimmed ? trimmed : null;
}

function resolveModelContextWindowCachePath(stateDir) {
  const resolved = normalizeStateDir(stateDir);
  return resolved ? path.join(resolved, MODEL_CONTEXT_WINDOW_CACHE_FILE) : null;
}

function loadModelContextWindowCache(cachePath) {
  const cache = new Map();
  if (!cachePath) return cache;
  try {
    if (!fs.existsSync(cachePath)) return cache;
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (typeof key === "string" && Number.isFinite(value) && value > 0) {
        cache.set(key, Math.floor(value));
      }
    }
  } catch {

  }
  return cache;
}

function persistModelContextWindowCache(cachePath, cache) {
  if (!cachePath) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const obj = {};
    for (const [key, value] of cache.entries()) obj[key] = value;
    fs.writeFileSync(cachePath, JSON.stringify(obj), "utf8");
  } catch {

  }
}

function createSessionContextService(opts) {
  const gatewayBridge = opts.gatewayBridge;
  const getActiveSessionKey = opts.getActiveSessionKey;
  const getRunActive = opts.getRunActive;
  const nowMs = opts.nowMs;
  const broadcast = opts.broadcast;
  const getActiveModelKey =
    typeof opts.getActiveModelKey === "function" ? opts.getActiveModelKey : () => null;
  const getActiveModelContextWindow =
    typeof opts.getActiveModelContextWindow === "function"
      ? opts.getActiveModelContextWindow
      : () => 0;

  let lastSnapshot = null;

  const modelContextWindowCachePath = resolveModelContextWindowCachePath(opts.stateDir);

  const modelContextWindowCache = loadModelContextWindowCache(modelContextWindowCachePath);

  async function refreshActiveSessionContext() {
    const sessionKey = getActiveSessionKey();
    if (!sessionKey) return null;
    let describeResp;
    let compactionResp;
    try {
      [describeResp, compactionResp] = await Promise.all([
        gatewayBridge.request("sessions.describe", { key: sessionKey }),
        gatewayBridge
          .request("sessions.compaction.list", { key: sessionKey })
          .catch(() => null),
      ]);
    } catch {
      return lastSnapshot;
    }
    if (sessionKey !== getActiveSessionKey()) return null;
    const session =
      describeResp && typeof describeResp === "object" && describeResp.session && typeof describeResp.session === "object"
        ? describeResp.session
        : null;
    if (!session) return lastSnapshot;

    const contextTokens = Number.isFinite(session.totalTokens)
      ? Math.floor(session.totalTokens)
      : 0;
    const contextTokensKnown = session.contextTokensKnown !== false;
    const describeWindow = Number.isFinite(session.contextTokens)
      ? Math.floor(session.contextTokens)
      : 0;
    const modelKey = getActiveModelKey();
    const catalogWindow = getActiveModelContextWindow();
    let contextWindow = describeWindow;
    if (describeWindow > 0) {

      if (modelKey && modelContextWindowCache.get(modelKey) !== describeWindow) {
        modelContextWindowCache.set(modelKey, describeWindow);
        persistModelContextWindowCache(modelContextWindowCachePath, modelContextWindowCache);
      }
    } else if (Number.isFinite(catalogWindow) && catalogWindow > 0) {
      contextWindow = Math.floor(catalogWindow);
      if (modelKey && modelContextWindowCache.get(modelKey) !== contextWindow) {
        modelContextWindowCache.set(modelKey, contextWindow);
        persistModelContextWindowCache(modelContextWindowCachePath, modelContextWindowCache);
      }
    } else if (modelKey && modelContextWindowCache.has(modelKey)) {

      contextWindow = modelContextWindowCache.get(modelKey);
    }
    const checkpoints =
      compactionResp && Array.isArray(compactionResp.checkpoints)
        ? compactionResp.checkpoints
        : [];
    const compactionCount = checkpoints.length;
    const compactionKind = compactionResp && compactionResp.metric === "hops"
      ? "hops"
      : "compactions";

    const snapshot = {
      type: "ocuclaw.session.context.snapshot",
      sessionKey,
      contextTokens,
      contextTokensKnown,
      contextWindow,
      compactionCount,
      compactionKind,
      runActive: !!getRunActive(),
      snapshotAtMs: nowMs(),

      ...(Number.isFinite(session.costUsd) && session.costUsd >= 0
        ? { costUsd: session.costUsd }
        : {}),
    };
    lastSnapshot = snapshot;
    broadcast(snapshot);
    return snapshot;
  }

  function broadcastRunActive(runActive) {
    if (!lastSnapshot || lastSnapshot.sessionKey !== getActiveSessionKey()) return;
    const snapshot = { ...lastSnapshot, runActive: !!runActive, snapshotAtMs: nowMs() };
    lastSnapshot = snapshot;
    broadcast(snapshot);
  }

  async function compactActiveSession(sessionKey) {
    try {
      await gatewayBridge.request("sessions.compact", { key: sessionKey });
      return { status: "accepted" };
    } catch (err) {
      return {
        status: "rejected",
        error: err && err.message ? String(err.message) : "sessions.compact failed",
      };
    }
  }

  function lastSnapshotForResume() {
    return lastSnapshot;
  }

  return {
    refreshActiveSessionContext,
    broadcastRunActive,
    compactActiveSession,
    lastSnapshotForResume,
  };
}

module.exports = { createSessionContextService };
