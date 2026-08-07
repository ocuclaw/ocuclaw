const { listLiveEvenTerminalInstances } = require("./discovery.cjs");
const { probeSessions, fetchSessionStatus, fetchHistory, postPrompt, createPromptSession, postInterrupt, postPermissionResponse, postQuestionResponse } = require("./rest-client.cjs");
const { mintEtSessionKey, parseEtSessionKey } = require("./session-key.cjs");
const { classifyFrame } = require("./frame-router.cjs");
const { subscribeEvents } = require("./sse-client.cjs");
const { createTerminalTranscriptCache } = require("./transcript-cache.cjs");
const { createEvenTerminalDisplayHistoryReader } = require("./display-history-reader.cjs");

const ET_PROVIDERS = ["codex", "claude"];

async function probeProviderAvailability(instance, provider, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const url =
    `http://127.0.0.1:${instance.port}/api/info` +
    `?provider=${encodeURIComponent(provider)}`;
  try {
    const res = await doFetch(url, {
      headers: { authorization: `Bearer ${instance.token}` },
      signal: AbortSignal.timeout(opts.providerHealthTimeoutMs ?? 4000),
    });
    if (!res.ok) return false;
    const body = await res.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    if (body.provider !== provider) return false;
    if (typeof body.error === "string" && body.error.trim()) return false;

    const version = typeof body.version === "string" ? body.version.trim() : "";
    if (!version || version.toLowerCase() === "unknown") return false;

    const account = body.account;
    if (!account || typeof account !== "object" || Array.isArray(account)) return false;
    return Object.values(account).some(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
  } catch {
    return false;
  }
}

function createEvenTerminalBridge(opts) {
  const logger = (opts && opts.logger) ? opts.logger : { warn() {} };
  const now = opts && typeof opts.now === "function" ? opts.now : Date.now;
  const providerHealthTtlMs = opts?.providerHealthTtlMs ?? 60000;

  let rows = [];

  let availableProviders = [];

  const providerHealthCache = new Map();

  const targets = new Map();
  const transcriptCache = createTerminalTranscriptCache({
    stateDir: opts && opts.stateDir,
    logger,
    historyReader:
      opts && typeof opts.transcriptHistoryReader === "function"
        ? opts.transcriptHistoryReader
        : createEvenTerminalDisplayHistoryReader(opts || {}),
  });

  function shouldReconcileStatus(status) {
    const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
    return normalized === "busy" || normalized === "awaiting";
  }

  async function resolveSessionStatus(instance, provider, session) {
    const status = typeof session.status === "string" && session.status.trim()
      ? session.status.trim()
      : null;
    if (!shouldReconcileStatus(status)) return status;
    const live = await fetchSessionStatus(instance, provider, session.id, {
      fetchImpl: opts && opts.fetchImpl,
    });
    if (live && live.found === true) return live.state || null;
    if (live && live.found === false) return "idle";
    return null;
  }

  async function refresh(refreshOpts = {}) {
    try {
      const instances = listLiveEvenTerminalInstances({
        instanceDir: opts && opts.instanceDir,
        isPidAlive: opts && opts.isPidAlive,
      });

      const nextRows = new Map();

      const nextTargets = new Map();

      if (!refreshOpts.skipProviderHealth) {
        const checkedAtMs = now();
        const providersToProbe = ET_PROVIDERS.filter((provider) => {
          const cached = providerHealthCache.get(provider);
          return !cached || checkedAtMs - cached.checkedAtMs >= providerHealthTtlMs;
        });
        await Promise.all(
          providersToProbe.map(async (provider) => {
            let available = false;
            for (const inst of instances) {
              if (
                await probeProviderAvailability(
                  { port: inst.port, token: inst.token },
                  provider,
                  {
                    fetchImpl: opts && opts.fetchImpl,
                    providerHealthTimeoutMs: opts?.providerHealthTimeoutMs,
                  },
                )
              ) {
                available = true;
                break;
              }
            }
            providerHealthCache.set(provider, { available, checkedAtMs });
          }),
        );
      }

      availableProviders = instances.length === 0
        ? []
        : ET_PROVIDERS.filter(
          (provider) => providerHealthCache.get(provider)?.available,
        );

      for (const inst of instances) {
        for (const provider of ET_PROVIDERS) {
          let sessions = [];
          try {
            sessions = await probeSessions(
              { port: inst.port, token: inst.token, cwd: inst.cwd },
              provider,
              { fetchImpl: opts && opts.fetchImpl },
            );
          } catch (err) {
            logger.warn(`[even-terminal] probe failed: ${err && err.message}`);
          }
          for (const s of sessions) {
            const dedup = `${provider}:${s.id}`;
            if (nextRows.has(dedup)) continue;
            const target = {
              port: inst.port,
              token: inst.token,
              cwd: s.cwd || inst.cwd,
              codexAppServerPort: inst.codexAppServerPort || null,
            };
            const status = await resolveSessionStatus(target, provider, s);
            nextRows.set(dedup, {
              key: mintEtSessionKey(provider, s.id),
              updatedAt: s.updatedAt,
              preview: s.title.slice(0, 80),
              firstUserMessage: s.title,
              title: s.title || "",
              pinned: false,
              pinnedAtMs: null,
              agentId: null,
              agentName: provider === "codex" ? "Codex" : "Claude",

              status,
            });
            nextTargets.set(dedup, target);
          }
        }
      }

      rows = [...nextRows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      targets.clear();
      for (const [k, v] of nextTargets) targets.set(k, v);
      transcriptCache.reconcileSessions(rows, targets);

      const toRebind = [];
      for (const [key, sub] of subs) {
        const parsed = parseEtSessionKey(key);
        if (!parsed) continue;
        const nt = targets.get(`${parsed.provider}:${parsed.sessionId}`);
        if (!nt) continue;
        if (nt.port !== sub.target.port || nt.token !== sub.target.token) {
          toRebind.push(key);
        }
      }
      for (const key of toRebind) {
        unsubscribe(key);
        subscribe(key);
      }
    } catch (err) {
      logger.warn(`[even-terminal] refresh failed: ${err && err.message}`);
    }
  }

  function getEtSessionRows() {
    return rows;
  }

  function getAvailableProviders() {
    return availableProviders.slice();
  }

  function getInstanceFor(provider, sessionId) {
    return targets.get(`${provider}:${sessionId}`) ?? null;
  }

  const subs = new Map();
  const classifiedCbs = new Set();
  let activeKey = null;

  function setActive(sessionKey) {
    activeKey = sessionKey || null;
  }

  function onClassified(cb) {
    classifiedCbs.add(cb);
    return () => classifiedCbs.delete(cb);
  }

  function subscribe(sessionKey) {
    if (subs.has(sessionKey)) return;
    const parsed = parseEtSessionKey(sessionKey);
    if (!parsed) return;
    const target = getInstanceFor(parsed.provider, parsed.sessionId);
    if (!target) return;
    const handle = subscribeEvents({
      port: target.port,
      token: target.token,
      sessionId: parsed.sessionId,

      needReplay: false,
      onFrame: (frame) => {
        const active = activeKey === sessionKey;
        const c = classifyFrame(frame, { active });
        const ev = { sessionKey, class: c.class, type: c.type, frame };
        for (const cb of classifiedCbs) {
          try { cb(ev); } catch {  }
        }
      },
    });
    subs.set(sessionKey, { stop: handle.stop, target });
  }

  async function getHistory(provider, sessionId) {
    const target = getInstanceFor(provider, sessionId);
    if (!target) return [];
    return fetchHistory({ port: target.port, token: target.token }, provider, sessionId, { fetchImpl: opts && opts.fetchImpl });
  }

  function unsubscribe(sessionKey) {
    const h = subs.get(sessionKey);
    if (h) { h.stop(); subs.delete(sessionKey); }
  }

  function stopAll() {
    for (const h of subs.values()) h.stop();
    subs.clear();
  }

  async function sendPrompt(provider, sessionId, text) {
    const target = getInstanceFor(provider, sessionId);
    if (!target) return;
    await postPrompt(
      { port: target.port, token: target.token, cwd: target.cwd },
      provider,
      sessionId,
      text,
      { fetchImpl: opts && opts.fetchImpl },
    );
  }

  function getInstanceForProvider(provider) {

    if (activeKey) {
      const parsed = parseEtSessionKey(activeKey);
      if (parsed && parsed.provider === provider) {
        const t = getInstanceFor(parsed.provider, parsed.sessionId);
        if (t) return t;
      }
    }

    for (const t of targets.values()) return t;

    try {
      const live = listLiveEvenTerminalInstances({
        instanceDir: opts && opts.instanceDir,
        isPidAlive: opts && opts.isPidAlive,
      });
      if (Array.isArray(live) && live.length) {
        const inst = live[0];
        return {
          port: inst.port,
          token: inst.token,
          cwd: inst.cwd,
          codexAppServerPort: inst.codexAppServerPort || null,
        };
      }
    } catch {  }
    return null;
  }

  async function createSession(provider, text, cwd) {
    const instance = getInstanceForProvider(provider);
    if (!instance) return null;
    const useCwd = (typeof cwd === "string" && cwd) ? cwd : instance.cwd;
    const res = await createPromptSession(
      { port: instance.port, token: instance.token, cwd: useCwd },
      provider,
      text,
      { fetchImpl: opts && opts.fetchImpl },
    );
    if (!res || !res.ok || !res.sessionId) return null;
    const newId = res.sessionId;
    const dedup = `${provider}:${newId}`;
    const newTarget = {
      port: instance.port,
      token: instance.token,
      cwd: useCwd,
      codexAppServerPort: instance.codexAppServerPort || null,
    };

    targets.set(dedup, newTarget);

    try {
      await refresh({ skipProviderHealth: true });
    } catch {  }
    if (!targets.has(dedup)) targets.set(dedup, newTarget);
    return mintEtSessionKey(provider, newId);
  }

  async function interruptSession(provider, sessionId) {
    const target = getInstanceFor(provider, sessionId);
    if (!target) return;
    await postInterrupt(
      { port: target.port, token: target.token, cwd: target.cwd },
      provider,
      sessionId,
      { fetchImpl: opts && opts.fetchImpl },
    );
  }

  async function respondPermission(provider, sessionId, decision) {
    const target = getInstanceFor(provider, sessionId);
    if (!target) return;
    await postPermissionResponse(
      { port: target.port, token: target.token },
      provider,
      sessionId,
      decision,
      { fetchImpl: opts && opts.fetchImpl },
    );
  }

  async function respondQuestion(provider, sessionId, answer) {
    const target = getInstanceFor(provider, sessionId);
    if (!target) return;
    await postQuestionResponse(
      { port: target.port, token: target.token },
      provider,
      sessionId,
      answer,
      { fetchImpl: opts && opts.fetchImpl },
    );
  }

  function searchTranscripts(query, searchOpts) {
    return transcriptCache.search(query, searchOpts || {});
  }

  function prewarmTranscripts() {
    return transcriptCache.prewarm();
  }

  return { refresh, getEtSessionRows, getAvailableProviders, getInstanceFor, getInstanceForProvider, getHistory, searchTranscripts, prewarmTranscripts, subscribe, unsubscribe, setActive, onClassified, stopAll, sendPrompt, createSession, interruptSession, respondPermission, respondQuestion };
}

module.exports = { createEvenTerminalBridge };
