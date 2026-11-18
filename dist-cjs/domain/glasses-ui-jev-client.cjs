const { Agent, EnvHttpProxyAgent, buildConnector, fetch: undiciFetch } = require("undici");

const DEFAULT_FETCH      = undiciFetch;

const ENDPOINT_URL = "https://api.typesafe.ai/v1/systemone";
const HEALTH_PATH = "/health";

const JEV_CONNECTION_DEFAULTS = Object.freeze({
  keepAliveTimeoutMs: 60_000,
  keepAliveMaxTimeoutMs: 120_000,
  connections: 4,

  minWarmIntervalMs: 20_000,

  refreshAfterIdleMs: 50_000,

  activeWindowMs: 180_000,

  warmTimeoutMs: 3_000,
});

const JEV_WARM_TRIGGERS = Object.freeze([
  "client_connect",
  "voice_start",
  "voice_transcribe",
  "typing",
  "send",
  "refresh",
  "bot_screen_jev",
]);

function jevFeaturesArmed(features     ) {
  const f = features && typeof features === "object" ? features : {};
  const armed = (c     ) =>
    !!c && typeof c === "object" && c.enabled === true && typeof c.apiKey === "string" && c.apiKey !== "";
  return armed(f.liveuiJev) || armed(f.botScreenJev) || armed(f.programCardsJev);
}

function createArmedJevConnection(features     , options      = {}, factory      = createJevConnection) {
  if (!jevFeaturesArmed(features)) return null;
  return (typeof factory === "function" ? factory : createJevConnection)(options);
}

function jevProxyEnv(env     ) {
  const e = env && typeof env === "object" ? env : {};
  const pick = (lower     , upper     ) => {
    const value = typeof e[lower] === "string" && e[lower] ? e[lower] : e[upper];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  const httpProxy = pick("http_proxy", "HTTP_PROXY");
  const httpsProxy = pick("https_proxy", "HTTPS_PROXY");
  if (!httpProxy && !httpsProxy) return null;
  const noProxy = pick("no_proxy", "NO_PROXY");
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),

    noProxy: noProxy || "",
  };
}

function positiveOr(value     , fallback     ) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createJevConnection(options      = {}) {
  const o = options || {};
  const fetchImpl = typeof o.fetchImpl === "function" ? o.fetchImpl : DEFAULT_FETCH;
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const setTimer = typeof o.setTimeout === "function" ? o.setTimeout : setTimeout;
  const clearTimer = typeof o.clearTimeout === "function" ? o.clearTimeout : clearTimeout;
  const emit = typeof o.emit === "function" ? o.emit : null;
  const url = typeof o.url === "string" && o.url ? o.url : ENDPOINT_URL;
  const d = JEV_CONNECTION_DEFAULTS;
  const keepAliveTimeoutMs = positiveOr(o.keepAliveTimeoutMs, d.keepAliveTimeoutMs);
  const minWarmIntervalMs = positiveOr(o.minWarmIntervalMs, d.minWarmIntervalMs);
  const refreshAfterIdleMs = positiveOr(o.refreshAfterIdleMs, d.refreshAfterIdleMs);
  const activeWindowMs = positiveOr(o.activeWindowMs, d.activeWindowMs);
  const warmTimeoutMs = positiveOr(o.warmTimeoutMs, d.warmTimeoutMs);

  let healthUrl      = null;
  try {
    healthUrl = new URL(HEALTH_PATH, url).toString();
  } catch (_) {
    healthUrl = null;
  }

  let connects = 0;
  let dispatcher      = null;
  let ownsDispatcher = false;
  let countsConnects = false;
  if (o.dispatcher !== undefined) {
    dispatcher = o.dispatcher;
  } else {
    const poolOptions = {
      keepAliveTimeout: keepAliveTimeoutMs,
      keepAliveMaxTimeout: positiveOr(o.keepAliveMaxTimeoutMs, d.keepAliveMaxTimeoutMs),
      connections: positiveOr(o.connections, d.connections),
    };

    const host      = globalThis;
    const proxy = jevProxyEnv(o.env && typeof o.env === "object" ? o.env : host.process && host.process.env);
    if (proxy) {

      dispatcher = new EnvHttpProxyAgent({ ...poolOptions, ...proxy });
    } else {
      const baseConnect = buildConnector({});
      dispatcher = new Agent({
        ...poolOptions,

        connect: (connectOptions     , callback     ) =>
          baseConnect(connectOptions, (error     , socket     ) => {
            if (!error) connects += 1;
            callback(error, socket);
          }),
      });
      countsConnects = true;
    }
    ownsDispatcher = true;
  }

  let inflight = 0;
  let lastUseAt = 0;
  let lastWarmAt = 0;
  let lastActivityAt = 0;
  let refreshTimer      = null;
  let closed = false;

  function isWarm() {
    return lastUseAt > 0 && now() - lastUseAt < keepAliveTimeoutMs - 1_000;
  }

  function connectCount() {
    return countsConnects ? connects : null;
  }

  const active      = new Set();

  function begin() {
    const handle      = { overlapped: false, ended: false };
    if (active.size > 0) {
      handle.overlapped = true;
      active.forEach((other     ) => { other.overlapped = true; });
    }
    active.add(handle);
    inflight += 1;
    return {
      done(intact     ) {
        if (handle.ended) return;
        handle.ended = true;
        active.delete(handle);
        inflight = Math.max(0, inflight - 1);
        if (intact) lastUseAt = now();
        else if (!handle.overlapped) lastUseAt = 0;
      },
      overlapped: () => handle.overlapped === true,
      reused(connectsBefore     ) {
        const after = connectCount();
        if (handle.overlapped || after === null || connectsBefore === null) return null;
        return after === connectsBefore;
      },
    };
  }

  function report(payload     ) {
    if (!emit) return;
    try {
      emit(payload);
    } catch (_) {

    }
  }

  function warm(trigger     ) {
    if (closed || !healthUrl || typeof fetchImpl !== "function") return false;
    const startedAt = now();
    const warmTrigger = JEV_WARM_TRIGGERS.includes(trigger) ? trigger : "refresh";
    if (inflight > 0) return false;
    if (lastWarmAt && startedAt - lastWarmAt < minWarmIntervalMs) return false;
    if (lastUseAt && startedAt - lastUseAt < minWarmIntervalMs) return false;
    if (warmTrigger !== "refresh" && isWarm() && startedAt - lastUseAt < refreshAfterIdleMs) return false;
    lastWarmAt = startedAt;
    const connectsBefore = connectCount();
    const request = begin();
    const finish = (outcome     , status     , intact     ) => {
      request.done(intact);
      report({
        warmTrigger,
        outcome,
        status,
        ms: Math.round(now() - startedAt),
        socketReused: request.reused(connectsBefore),
      });
    };
    Promise.resolve()
      .then(() => fetchImpl(healthUrl, {
        method: "GET",
        ...(dispatcher ? { dispatcher } : {}),
        signal: AbortSignal.timeout(warmTimeoutMs),
      }))
      .then(async (response     ) => {

        await response.text();
        const status = Number.isFinite(response.status) ? response.status : 0;
        finish(response.ok ? "warmed" : "http_error", status, true);
      })
      .catch(() => finish("failed", null, false));
    return true;
  }

  function scheduleRefresh() {
    if (closed || refreshTimer) return;
    const base = Math.max(lastUseAt, lastWarmAt, 0) || now();
    const delay = Math.max(1_000, base + refreshAfterIdleMs - now());
    refreshTimer = setTimer(onRefresh, delay);

    if (refreshTimer && typeof refreshTimer.unref === "function") refreshTimer.unref();
  }

  function onRefresh() {
    refreshTimer = null;
    if (closed) return;
    if (!lastActivityAt || now() - lastActivityAt > activeWindowMs) return;
    warm("refresh");
    scheduleRefresh();
  }

  function noteActivity(trigger     , activityOptions      = {}) {
    if (closed) return false;
    lastActivityAt = now();
    const sent = activityOptions && activityOptions.warm === false ? false : warm(trigger);
    scheduleRefresh();
    return sent;
  }

  function close() {
    closed = true;
    if (refreshTimer) {
      clearTimer(refreshTimer);
      refreshTimer = null;
    }
    if (ownsDispatcher && dispatcher && typeof dispatcher.close === "function") {
      return Promise.resolve(dispatcher.close()).catch(() => {});
    }
    return Promise.resolve();
  }

  return {
    dispatcher,
    isWarm,
    connectCount,
    begin,
    warm,
    noteActivity,
    close,
    isClosed: () => closed,
  };
}

const JEV_REASONS = Object.freeze([
  "no_key",
  "disabled",
  "misconfigured",
  "aborted",
  "timeout",
  "http_401",
  "http_422",
  "http_429",
  "http_529",
  "http_other",
  "network",
  "bad_json",
]);

const MAPPED_STATUSES = new Set([401, 422, 429, 529]);

function failure(reason     , ms     , net      = null) {
  return net ? { ok: false, reason, ms, warm: net.warm, socketReused: net.socketReused } : { ok: false, reason, ms };
}

function isTimeout(error     ) {
  if (!error) return false;
  return error.name === "TimeoutError" || error.name === "AbortError";
}

function requestSignal(budgetMs     , callerSignal     ) {
  const budget = AbortSignal.timeout(budgetMs);
  const ctor      = AbortSignal;
  if (!callerSignal || typeof ctor.any !== "function") return budget;
  return ctor.any([budget, callerSignal]);
}

function createJevClient(options      = {}) {
  const opts = options || {};
  const apiKey = typeof opts.apiKey === "string" && opts.apiKey ? opts.apiKey : null;
  const enabled = opts.enabled !== false;
  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : DEFAULT_FETCH;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const url = typeof opts.url === "string" && opts.url ? opts.url : ENDPOINT_URL;
  const model = typeof opts.model === "string" && opts.model ? opts.model : "";
  const defaultQuestions = opts.questions && typeof opts.questions === "object" ? opts.questions : null;
  const sharedConnection = opts.connection && typeof opts.connection.begin === "function" ? opts.connection : null;

  let ownConnection      = null;
  function connection() {
    if (sharedConnection) return sharedConnection;
    if (!ownConnection) {
      ownConnection = createJevConnection({ url, fetchImpl, now, dispatcher: opts.dispatcher, env: opts.env });
    }
    return ownConnection;
  }

  async function decide(state     , callOptions      = {}) {
    const startedAt = now();
    const elapsed = () => now() - startedAt;
    const budgetMs = Number.isFinite(callOptions && callOptions.budgetMs) ? callOptions.budgetMs : 400;
    const turnId = (callOptions && callOptions.turnId) || null;

    const questions = (callOptions && callOptions.questions) || defaultQuestions;
    const callerSignal = (callOptions && callOptions.signal) || null;

    const assets = callOptions && callOptions.assets && typeof callOptions.assets === "object" ? callOptions.assets : null;

    if (!enabled) return failure("disabled", elapsed());
    if (!apiKey) return failure("no_key", elapsed());

    if (!model || !questions || Object.keys(questions).length === 0) {
      return failure("misconfigured", elapsed());
    }
    if (typeof fetchImpl !== "function") return failure("network", elapsed());
    if (callerSignal && callerSignal.aborted) return failure("aborted", elapsed());

    const conn = connection();
    const warm = conn.isWarm();
    const connectsBefore = conn.connectCount();
    const request = conn.begin();

    const net = () => ({ warm, socketReused: request.reused(connectsBefore) });
    const done = (intact     ) => request.done(intact);
    let response = null;
    let text = "";
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(assets ? { "typesafe-danger-zone-images": "true" } : {}),
        },
        body: JSON.stringify(assets ? { model, state, assets, questions } : { model, state, questions }),
        ...(conn.dispatcher ? { dispatcher: conn.dispatcher } : {}),
        signal: requestSignal(budgetMs, callerSignal),
      });
      text = await response.text();
      done(true);
    } catch (error) {

      done(false);

      if (callerSignal && callerSignal.aborted) return failure("aborted", elapsed(), net());
      return failure(isTimeout(error) ? "timeout" : "network", elapsed(), net());
    }

    const status = response && Number.isFinite(response.status) ? response.status : 0;
    if (!response || !response.ok) {

      return failure(MAPPED_STATUSES.has(status) ? `http_${status}` : "http_other", elapsed(), net());
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      return failure("bad_json", elapsed(), net());
    }
    if (!parsed || typeof parsed.answers !== "object" || !parsed.answers) {
      return failure("bad_json", elapsed(), net());
    }

    const inputTokens = parsed.usage && Number.isFinite(Number(parsed.usage.input_tokens))
      ? Number(parsed.usage.input_tokens)
      : null;
    return { ok: true, answers: parsed.answers, ms: elapsed(), inputTokens, turnId, ...net() };
  }

  function close() {
    const own = ownConnection;
    ownConnection = null;
    return own ? own.close() : Promise.resolve();
  }

  return { decide, close, enabled, hasKey: Boolean(apiKey), model };
}

module.exports = { JEV_CONNECTION_DEFAULTS, JEV_WARM_TRIGGERS, jevFeaturesArmed, createArmedJevConnection, jevProxyEnv, createJevConnection, JEV_REASONS, createJevClient };
