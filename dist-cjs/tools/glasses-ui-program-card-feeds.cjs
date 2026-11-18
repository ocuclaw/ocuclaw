const PROGRAM_CARD_FEED_LIMITS = Object.freeze({
  maxSubscriptions: 4,
  maxFeeds: 4,
  leaseMs: 150_000,
  valueBytesMax: 16_384,
  httpTimeoutMs: 8_000,
  everySec: { http: [5, 3600], "system-stats": [2, 3600] }                                    ,

  absentHttpEveryMs: 5 * 60_000,

  settleSubscribeWaitMs: 1_500,
  settleDataWaitMs: 8_500,

  settleReturnWaitMs: 2_500,
  settlePollMs: 50,

  settleAsksMax: 3,
});

const NAME = /^[a-z][A-Za-z0-9_]{0,23}$/;
const JSON_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

function parseProgramCardFeed(raw     )                                                                       {
  const name = raw && typeof raw.name === "string" ? raw.name : "";
  if (!NAME.test(name)) return { ok: false, name: name.slice(0, 24), error: "bad feed name" };
  const kind = raw.kind;

  const everySec = PROGRAM_CARD_FEED_LIMITS.everySec;
  const bounds = typeof kind === "string" && Object.hasOwn(everySec, kind) ? everySec[kind] : undefined;
  if (!bounds) return { ok: false, name, error: `unknown feed kind ${String(kind).slice(0, 20)}` };
  const every = raw.every;
  if (!Number.isFinite(every) || every < bounds[0] || every > bounds[1]) {
    return { ok: false, name, error: `every must be ${bounds[0]} to ${bounds[1]} seconds` };
  }
  const feed      = { name, kind, every };
  if (kind === "http") {
    if (typeof raw.url !== "string" || raw.url.length > 2048) return { ok: false, name, error: "http feed needs a url" };
    feed.url = raw.url;
    if (raw.path !== undefined) {
      if (typeof raw.path !== "string" || !JSON_PATH.test(raw.path)) return { ok: false, name, error: "bad path" };
      feed.path = raw.path;
    }
  }
  return { ok: true, feed };
}

const HOST = /^[a-z0-9.-]{1,253}$/;

function parseProgramCardHosts(raw     , max        )           {
  if (!Array.isArray(raw)) return [];
  const hosts = raw.filter((h     ) => typeof h === "string").map((h        ) => h.toLowerCase()).filter((h        ) => HOST.test(h));
  return [...new Set        (hosts)].sort().slice(0, max);
}

const sitesOf = (raw     ) => (raw === "ask" || raw === "off" ? raw : "");

function programCardFeedOutcome(result     , feed     )                                                 {

  if (result && result.ok === true) {
    return result.value === undefined ? { ok: false, code: feed && feed.path ? "path_empty" : "no_value" } : { ok: true, code: "arrived" };
  }
  const error = String(result && result.error ? result.error : "");
  if (error === "no value") return { ok: false, code: feed && feed.path ? "path_empty" : "no_value" };

  if (/^LiveUI refresh is paused$/.test(error)) return { ok: false, code: "paused" };
  if (/^http recipe timeout after \d+ms$/.test(error)) return { ok: false, code: "timed_out" };
  if (/^value is \d+ bytes, over \d+; pick less with path$/.test(error)) return { ok: false, code: "too_big" };
  const status = /^http recipe got status (\d{3})$/.exec(error);
  if (status) return { ok: false, code: "http_status", status: Number(status[1]) };
  if (/^http recipe redirect destination not in allowlist: /.test(error)) return { ok: false, code: "redirected" };
  if (/^http recipe (?:redirect )?destination (?:blocked|not in allowlist): /.test(error)) return { ok: false, code: "blocked" };
  return { ok: false, code: "address_failed" };
}

function programCardFeedRefusal(checked     )                              {
  if (checked && typeof checked.site === "string") return { ok: false, code: "site_waiting" };
  const message = String(checked && checked.message ? checked.message : "");
  if (/sites are off/i.test(message)) return { ok: false, code: "sites_off" };
  if (/is off for this card/i.test(message)) return { ok: false, code: "site_off_for_card" };

  if (/^allow .+ on the glasses$/i.test(message)) return { ok: false, code: "site_waiting" };

  const code = checked && typeof checked.code === "string" ? checked.code : "";
  if (code === "refresh_disabled") return { ok: false, code: "host_off" };
  if (code === "refresh_host_not_allowed") return { ok: false, code: "host_not_allowed" };
  return { ok: false, code: "refused" };
}

const PROGRAM_CARD_FEED_HEALTH_REASONS = Object.freeze([
  "bad_feed", "refused", "blocked", "redirected", "address_failed", "http_status", "timed_out", "path_empty", "no_value", "too_big",
  "site_waiting", "sites_off", "site_off_for_card", "host_off", "host_not_allowed", "paused",
]);

const HEALTH_FAILS_IN_A_ROW = 2;

const UNCHECKED_FEED_CODES = new Set(["paused", "sites_off", "site_off_for_card", "host_off", "host_not_allowed"]);

const signatureOf = (card        , feeds       , block          , sites        ) => JSON.stringify([card, feeds, block, sites]);

const shortError = (error     ) => String(error ?? "failed").replace(/^http recipe /, "").slice(0, 200);

function createProgramCardFeeds(deps     ) {
  const limits = { ...PROGRAM_CARD_FEED_LIMITS, ...(deps.limits || {}) };
  const send = deps.send;
  const executeRecipe = deps.executeRecipe;

  const validate = typeof deps.validate === "function" ? deps.validate : (feed     ) => ({ ok: true, recipe: { kind: feed.kind } });
  const isPaused = typeof deps.isPaused === "function" ? deps.isPaused : () => false;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const emitLifecycle = typeof deps.emitLifecycle === "function" ? deps.emitLifecycle : () => {};
  const subs = new Map();
  let presence = "unknown";

  function push(sub        , name        , result     ) {
    const frame      = { type: "program_card_data", sub, name, ok: result.ok === true, at: now() };
    if (frame.ok) frame.value = result.value;
    else frame.error = shortError(result.error);
    if (!frame.ok && typeof result.site === "string") frame.site = result.site;
    try { send(frame); } catch (err     ) {
      emitLifecycle("program_card_feed_send_failed", "warn", { sub, name, error: String(err && err.message ? err.message : err) });
    }
  }

  function everyMs(runner     ) {
    const base = runner.feed.every * 1000;
    const absent = presence === "absent" || presence === "in_case";
    return absent && runner.feed.kind === "http" ? Math.max(base, limits.absentHttpEveryMs) : base;
  }

  function stopRunner(runner     ) {
    runner.stopped = true;
    if (runner.timer) clearTimeoutFn(runner.timer);
    runner.timer = null;
  }

  function stopSub(entry     , reason        ) {
    for (const runner of entry.feeds.values()) stopRunner(runner);
    subs.delete(entry.sub);
    emitLifecycle("program_card_feeds_stopped", "debug", { sub: entry.sub, card: entry.card, reason });
  }

  function schedule(entry     , runner     , delayMs        ) {
    if (runner.stopped) return;
    if (runner.timer) clearTimeoutFn(runner.timer);
    runner.timer = setTimeoutFn(() => { runner.timer = null; run(entry, runner); }, Math.max(0, delayMs));
  }

  async function run(entry     , runner     ) {
    if (runner.stopped) return;
    if (now() > entry.leaseUntil) { stopSub(entry, "lease_expired"); return; }
    if (runner.refused) return;
    if (isPaused()) {
      runner.delivered = true;
      runner.outcome = { ok: false, code: "paused", atMs: now() };
      push(entry.sub, runner.feed.name, { ok: false, error: "LiveUI refresh is paused" });
      schedule(entry, runner, everyMs(runner));
      return;
    }
    if (runner.inFlight) return;
    runner.inFlight = true;
    const startedAt = now();
    let result     ;
    try {
      const out = await executeRecipe(runner.recipe, entry.block, entry.sites);
      if (out && out.error === undefined && out.output !== undefined) {
        const bytes = new TextEncoder().encode(JSON.stringify(out.output) ?? "").byteLength;
        result = bytes > limits.valueBytesMax
          ? { ok: false, error: `value is ${bytes} bytes, over ${limits.valueBytesMax}; pick less with path` }
          : { ok: true, value: out.output };
      } else {
        result = { ok: false, error: out && out.error ? out.error : "no value" };
      }
    } catch (err     ) {
      result = { ok: false, error: err && err.message ? err.message : String(err) };
    }
    runner.inFlight = false;

    if (runner.stopped || runner.refused) return;
    emitLifecycle("program_card_feed_run", "debug", {
      sub: entry.sub, name: runner.feed.name, kind: runner.feed.kind, ok: result.ok, ms: now() - startedAt,
    });

    runner.delivered = true;

    runner.outcome = { ...programCardFeedOutcome(result, runner.feed), atMs: now() };
    if (runner.outcome.ok) runner.arrived = true;

    runner.fails = runner.outcome.ok ? 0 : (runner.fails || 0) + 1;
    push(entry.sub, runner.feed.name, result);
    schedule(entry, runner, everyMs(runner) - (now() - startedAt));
  }

  function admit(entry     , runner     ) {
    const checked = validate(runner.feed, entry.block, entry.sites);
    if (checked && checked.ok) {
      const wasRefused = runner.refused;
      runner.refused = false;
      runner.recipe = checked.recipe;
      runner.site = null;

      if (wasRefused) { runner.outcome = null; runner.delivered = false; }
      return wasRefused;
    }
    runner.refused = true;

    runner.site = checked && typeof checked.site === "string" ? checked.site : null;
    runner.outcome = { ...programCardFeedRefusal(checked), atMs: now() };
    runner.arrived = false;
    if (runner.timer) { clearTimeoutFn(runner.timer); runner.timer = null; }
    push(entry.sub, runner.feed.name, {
      ok: false,
      error: (checked && checked.message) || "feed refused",
      ...(checked && typeof checked.site === "string" ? { site: checked.site } : {}),
    });
    return false;
  }

  function recheck(entry     ) {
    for (const runner of entry.feeds.values()) {
      if (runner.feed.kind !== "http") continue;
      if (admit(entry, runner)) schedule(entry, runner, 0);
    }
  }

  function subscribe(msg     ) {
    const sub = typeof msg.sub === "string" ? msg.sub.slice(0, 80) : "";
    const card = typeof msg.card === "string" ? msg.card.slice(0, 64) : "";
    if (!sub || !Array.isArray(msg.feeds)) return;
    const parsed = msg.feeds.slice(0, limits.maxFeeds).map(parseProgramCardFeed);
    const feeds = parsed.filter((p     ) => p.ok).map((p     ) => p.feed);
    const block = parseProgramCardHosts(msg.block, limits.maxFeeds);
    const sites = sitesOf(msg.sites);

    const signature = signatureOf(card, feeds, block, sites);
    const existing = subs.get(sub);
    if (existing && existing.signature === signature) {
      existing.leaseUntil = now() + limits.leaseMs;

      recheck(existing);
      return;
    }
    if (existing) stopSub(existing, "replaced");

    for (const other of [...subs.values()]) if (now() > other.leaseUntil) stopSub(other, "lease_expired");
    while (subs.size >= limits.maxSubscriptions) stopSub(subs.values().next().value, "evicted");

    const entry      = { sub, card, block, sites, signature, leaseUntil: now() + limits.leaseMs, feeds: new Map(), startedAt: now(),
      rejected: parsed.filter((p     ) => !p.ok).map((p     ) => p.name) };
    subs.set(sub, entry);
    emitLifecycle("program_card_feeds_started", "debug", { sub, card, feeds: feeds.map((f     ) => `${f.name}:${f.kind}`) });
    for (const p of parsed) if (!p.ok) push(sub, p.name, { ok: false, error: p.error });
    for (const feed of feeds) {
      const runner      = { feed, recipe: null, timer: null, inFlight: false, stopped: false, refused: false };
      entry.feeds.set(feed.name, runner);
      admit(entry, runner);
      if (!runner.refused) schedule(entry, runner, 0);
    }
  }

  async function settle(card        , opts      = {}) {
    const subscribeWaitMs = Number.isFinite(opts.subscribeWaitMs) ? opts.subscribeWaitMs : limits.settleSubscribeWaitMs;
    const dataWaitMs = Number.isFinite(opts.dataWaitMs) ? opts.dataWaitMs : limits.settleDataWaitMs;
    const returnWaitMs = Number.isFinite(opts.returnWaitMs) ? opts.returnWaitMs : limits.settleReturnWaitMs;
    const askSite = typeof opts.askSite === "function" ? opts.askSite : async () => "unavailable";
    const sleep = () => new Promise((resolve) => setTimeoutFn(resolve, limits.settlePollMs));
    const startedAt = now();

    const httpRunners = () => {
      let entry      = null;
      for (const candidate of subs.values()) if (candidate.card === card) entry = candidate;
      return entry ? [...entry.feeds.values()].filter((runner     ) => runner.feed.kind === "http" && !runner.stopped) : null;
    };
    while (httpRunners() === null && now() - startedAt < subscribeWaitMs) await sleep();
    const first = httpRunners();
    if (!first || first.length === 0) return { feeds: 0, asked: 0, allowed: 0, ready: true, ms: now() - startedAt };
    const sites = [...new Set        (first.filter((runner     ) => runner.refused && runner.site).map((runner     ) => runner.site))]
      .slice(0, limits.settleAsksMax);
    let allowed = 0;
    for (const host of sites) {
      let answer = "no_answer";
      try { answer = await askSite(host); } catch (_) { answer = "no_answer"; }
      if (answer === "allow") allowed += 1;
    }
    if (allowed) {

      const askedAt = now();
      while (httpRunners() === null && now() - askedAt < returnWaitMs) await sleep();

      for (const entry of subs.values()) if (entry.card === card) recheck(entry);
    }
    const dataFrom = now();
    const waiting = () => (httpRunners() || []).some((runner     ) => !runner.refused && !runner.delivered);
    while (waiting() && now() - dataFrom < dataWaitMs) await sleep();

    const last = httpRunners() || [];
    const result = { feeds: last.length, asked: sites.length, allowed, ready: !waiting(),
      refused: last.filter((runner     ) => runner.refused).length, ms: now() - startedAt };
    emitLifecycle("program_card_feeds_settled", "info", result);
    return result;
  }

  async function outcomes(card        , opts      = {}) {
    const sinceMs = Number.isFinite(opts.sinceMs) ? opts.sinceMs : 0;
    const subscribeWaitMs = Number.isFinite(opts.subscribeWaitMs) ? opts.subscribeWaitMs : limits.settleSubscribeWaitMs;
    const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : limits.settleDataWaitMs;
    const sleep = () => new Promise((resolve) => setTimeoutFn(resolve, limits.settlePollMs));
    const startedAt = now();
    const latest = (since        ) => {
      let entry      = null;
      for (const candidate of subs.values()) if (candidate.card === card && candidate.startedAt >= since) entry = candidate;
      return entry;
    };
    while (!latest(sinceMs) && now() - startedAt < subscribeWaitMs) await sleep();

    const current = () => latest(sinceMs) || latest(0);
    const pending = () => {
      const entry = current();
      return !!entry && [...entry.feeds.values()].some((runner     ) => !runner.stopped && !runner.refused && !runner.outcome);
    };
    const dataFrom = now();
    while (pending() && now() - dataFrom < waitMs) await sleep();
    const entry = current();
    if (!entry) return null;
    const hostOf = (feed     ) => {
      if (feed.kind !== "http") return "";
      try { return new URL(feed.url).hostname.toLowerCase(); } catch (_) { return ""; }
    };
    const rows        = [];
    for (const name of entry.rejected) rows.push({ name, kind: "", host: "", status: "failed", reason: "bad_feed" });
    for (const runner of entry.feeds.values()) {

      const outcome = runner.arrived && runner.outcome && !runner.outcome.ok ? { ok: true, code: "arrived" } : runner.outcome;
      const reason = outcome ? outcome.code : "not_run";
      const status = !outcome ? "unchecked" : outcome.ok ? "ok"
        : reason === "site_waiting" ? "waiting"
          : UNCHECKED_FEED_CODES.has(reason) ? "unchecked" : "failed";
      rows.push({ name: runner.feed.name, kind: runner.feed.kind, host: hostOf(runner.feed), status, reason,
        ...(outcome && Number.isInteger(outcome.status) ? { httpStatus: outcome.status } : {}) });
    }
    return rows;
  }

  function health(card        ) {
    if (typeof card !== "string" || !card) return [];
    let entry      = null;
    for (const candidate of subs.values()) if (candidate.card === card) entry = candidate;
    if (!entry || now() > entry.leaseUntil) return [];
    const rows        = [];
    for (const name of entry.rejected) rows.push({ part: "feed", use: NAME.test(name) ? name : "", reason: "bad_feed" });
    let pausedNow = false;
    try { pausedNow = isPaused() === true; } catch (_) { pausedNow = false; }
    for (const runner of entry.feeds.values()) {
      if (runner.stopped) continue;

      if (pausedNow && !runner.refused) { rows.push({ part: "feed", use: runner.feed.name, reason: "paused" }); continue; }
      const outcome = runner.outcome;

      if (!outcome || outcome.ok || outcome.code === "paused") continue;
      if (!(PROGRAM_CARD_FEED_HEALTH_REASONS                     ).includes(outcome.code)) continue;

      if (runner.arrived && !runner.refused && (runner.fails || 0) < HEALTH_FAILS_IN_A_ROW) continue;
      rows.push({ part: "feed", use: runner.feed.name, reason: outcome.code,
        ...(Number.isFinite(outcome.atMs) ? { atMs: outcome.atMs } : {}),
        ...(outcome.code === "http_status" && Number.isInteger(outcome.status) ? { status: outcome.status } : {}) });
    }
    return rows;
  }

  return {
    settle,
    outcomes,
    health,

    handle(msg     ) {
      if (!msg || typeof msg !== "object") return;
      if (msg.op === "subscribe") subscribe(msg);
      else if (msg.op === "unsubscribe" && typeof msg.sub === "string") {
        const entry = subs.get(msg.sub);
        if (entry) stopSub(entry, "unsubscribed");
      }
    },
    setPresence(value     ) {
      const was = presence;
      presence = typeof value === "string" ? value : "unknown";
      const back = (was === "absent" || was === "in_case") && presence !== "absent" && presence !== "in_case";
      if (!back) return;

      for (const entry of subs.values()) {
        for (const runner of entry.feeds.values()) if (runner.feed.kind === "http" && !runner.refused) schedule(entry, runner, 0);
      }
    },

    grantsChanged() { for (const entry of subs.values()) recheck(entry); },
    stopAll() { for (const entry of [...subs.values()]) stopSub(entry, "stopped"); },
    activeCount() { return subs.size; },
  };
}

module.exports = { PROGRAM_CARD_FEED_LIMITS, parseProgramCardFeed, parseProgramCardHosts, programCardFeedOutcome, programCardFeedRefusal, PROGRAM_CARD_FEED_HEALTH_REASONS, createProgramCardFeeds };
