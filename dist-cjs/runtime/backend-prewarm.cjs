const DEFAULT_MIN_INTERVAL_MS = 4_000;
const PREWARM_HISTORY_LIMIT = 1;
const PREWARM_SOURCES = new Set(["typing", "voice"]);

                         

function createBackendPrewarm(opts                       ) {
  const { request, getBackendKind, resolveSessionKey } = opts;
  const scopeSessionKey = opts.scopeSessionKey ?? ((key        ) => key);
  const isTurnActive = opts.isTurnActive ?? (() => false);
  const onOutcome = opts.onOutcome ?? (() => {});
  const minIntervalMs =
    typeof opts.minIntervalMs === "number" && Number.isFinite(opts.minIntervalMs)
      ? Math.max(0, opts.minIntervalMs)
      : DEFAULT_MIN_INTERVAL_MS;
  const now = opts.now ?? Date.now;

  const lastStartedAt = new Map                ();
  const inFlight = new Set        ();

  function noteInputStarted(
    input                                                    ,
  )                                 {
    const source =
      input && typeof input.source === "string" && PREWARM_SOURCES.has(input.source)
        ? input.source
        : "unknown";
    const finish = (
      status                                 ,
      extra                                 = {},
    )                                 => {
      const outcome                        = { status, source, ...extra };
      try {
        onOutcome(outcome);
      } catch (_) {

      }
      return Promise.resolve(outcome);
    };
    let backendKind                            = null;
    try {
      backendKind = getBackendKind();
    } catch (_) {
      backendKind = null;
    }
    if (backendKind !== "openclaw") return finish("unsupported_backend");
    const requested =
      input && typeof input.sessionKey === "string" && input.sessionKey.trim()
        ? input.sessionKey.trim()
        : null;
    let sessionKey                = null;
    try {
      sessionKey = resolveSessionKey(requested);
    } catch (_) {
      sessionKey = null;
    }
    if (!sessionKey) return finish("no_session");
    if (isTurnActive(sessionKey)) return finish("turn_active", { sessionKey });
    const gatewaySessionKey = scopeSessionKey(sessionKey);
    if (inFlight.has(gatewaySessionKey)) return finish("in_flight", { sessionKey });
    const startedAt = now();
    const last = lastStartedAt.get(gatewaySessionKey);
    if (last !== undefined && startedAt - last < minIntervalMs) {
      return finish("throttled", { sessionKey });
    }
    lastStartedAt.set(gatewaySessionKey, startedAt);
    inFlight.add(gatewaySessionKey);
    let pending                  ;
    try {
      pending = Promise.resolve(
        request("chat.history", { sessionKey: gatewaySessionKey, limit: PREWARM_HISTORY_LIMIT }),
      );
    } catch (err) {
      pending = Promise.reject(err);
    }
    const warmedKey = sessionKey;
    return pending.then(
      () => {
        inFlight.delete(gatewaySessionKey);
        return finish("warmed", { sessionKey: warmedKey, elapsedMs: now() - startedAt });
      },
      (err     ) => {
        inFlight.delete(gatewaySessionKey);
        return finish("failed", {
          sessionKey: warmedKey,
          elapsedMs: now() - startedAt,
          error: err && err.message ? String(err.message) : String(err),
        });
      },
    );
  }

  return { noteInputStarted };
}

module.exports = { createBackendPrewarm };
