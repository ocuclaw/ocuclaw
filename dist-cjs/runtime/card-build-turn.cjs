const CARD_BUILD_TURN_IDEMPOTENCY_PREFIX = "card-build:";

const CARD_BUILD_TURN_ASK_TTL_MS = 10 * 60_000;

const CARD_BUILD_TURN_LATE_END_MS = 10_000;

const CARD_BUILD_TURN_MAX_MS = 30 * 60_000;

const CARD_TURN_SWITCH_WAIT_MS = 1500;

function cardBuildTurnMessage(title               ) {
  const name = title ? ` "${title}"` : "";
  return `[ocuclaw card build] Plugin-generated notification - NOT the wearer speaking. Build the card${name} now: the wearer said yes to your card ask above. Write it to that plan, with the brief and guides from that answer.`;
}

function createCardBuildTurns(deps

 ) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const retryMs = Number.isFinite(deps.retryMs) ? Number(deps.retryMs) : 2000;
  const settleMs = Number.isFinite(deps.settleMs) ? Number(deps.settleMs) : 3000;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const entries = new Map                    ();
  const wait = (ms        ) => new Promise((resolve) => setTimeout(resolve, ms));

  function unref(timer                               ) {
    const handle      = timer;
    if (handle && typeof handle.unref === "function") handle.unref();
    return timer;
  }

  async function plan(sessionKey        , info                                                        = {}) {
    try {
      if (!sessionKey || deps.enabled() !== true) return false;
      const config = await deps.sessionConfig(sessionKey);
      if (!config || config.fastMode === true || config.fastModeSupported !== true) {
        log("card_build_turn_skipped", {
          reason: !config ? "no_config" : config.fastMode === true ? "chat_fast" : "fast_unsupported",
        });
        return false;
      }
      drop(entries.get(deps.slot(sessionKey)) || null, "replaced");
      entries.set(deps.slot(sessionKey), {
        sessionKey,
        title: typeof info.title === "string" && info.title ? info.title : null,
        phase: "ask",
        plannedAt: now(),
        startedAt: null,
        fastOn: false,
        yesUnspent: typeof info.yesUnspent === "function" ? info.yesUnspent : null,
        askRunId: null,
        buildKey: null,
        settleTimer: null,
        maxTimer: null,
      });
      log("card_build_turn_planned", {});
      return true;
    } catch (_) {
      return false;
    }
  }

  function unspent(entry            ) {
    try {
      return entry.yesUnspent ? entry.yesUnspent() === true : deps.yesUnspent(entry.sessionKey) === true;
    } catch (_) {
      return false;
    }
  }

  function stale(entry            ) {
    return now() - entry.plannedAt > CARD_BUILD_TURN_ASK_TTL_MS;
  }

  function clearTimers(entry            ) {
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
    if (entry.maxTimer) clearTimeout(entry.maxTimer);
    entry.settleTimer = null;
    entry.maxTimer = null;
  }

  function drop(entry                   , reason        ) {
    if (!entry) return;
    clearTimers(entry);
    if (entries.get(deps.slot(entry.sessionKey)) === entry) entries.delete(deps.slot(entry.sessionKey));
    log("card_build_turn_dropped", { reason });
    if (entry.buildKey && typeof deps.released === "function") {
      try {
        deps.released(entry.buildKey);
      } catch (_) {

      }
    }
  }

  function carriesBuild(buildKey        , runId                )                          {
    if (typeof buildKey !== "string" || !buildKey) return null;
    const entry = entries.get(deps.slot(buildKey));
    if (!entry) return null;
    const run = typeof runId === "string" && runId ? runId : null;
    if (entry.cardTurn) return null;
    if (entry.phase === "build" && !entry.buildKey) {

      entry.buildKey = buildKey;
      if (run) entry.askRunId = run;
      return "carry";
    }
    if (entry.phase === "build") {

      const late = (!!run && run === entry.askRunId)
        || (entry.startedAt !== null && now() - entry.startedAt < CARD_BUILD_TURN_LATE_END_MS);
      return late ? "late" : null;
    }
    if (stale(entry) || !unspent(entry)) return null;
    entry.buildKey = buildKey;
    if (run && !entry.askRunId) entry.askRunId = run;
    return "carry";
  }

  async function startBuild(entry            ) {
    entry.phase = "starting";
    if (!unspent(entry)) {

      drop(entry, "yes_spent");
      return;
    }

    for (let attempt = 0; attempt < 2 && !entry.fastOn; attempt += 1) {
      if (attempt > 0) await wait(retryMs);
      try {
        const result = await deps.setFastMode(entry.sessionKey, true);
        entry.fastOn = !!result && result.status === "accepted";
      } catch (_) {
        entry.fastOn = false;
      }
    }
    entry.phase = "build";
    entry.startedAt = now();
    entry.maxTimer = unref(setTimeout(() => {
      entry.maxTimer = null;
      log("card_build_turn_overran", {});
      void finish(entry);
    }, CARD_BUILD_TURN_MAX_MS));
    log("card_build_turn_start", { fast: entry.fastOn });
    try {
      await deps.dispatch({
        sessionKey: entry.sessionKey,
        message: cardBuildTurnMessage(entry.title),
        idempotencyKey: `${CARD_BUILD_TURN_IDEMPOTENCY_PREFIX}${entry.sessionKey}:${entry.plannedAt}`,
      });
    } catch (_) {
      log("card_build_turn_dispatch_failed", {});
      const fastOn = entry.fastOn;
      drop(entry, "dispatch_failed");
      if (fastOn) await restore(entry);
    }
  }

  function settle(entry            ) {
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
    entry.settleTimer = unref(setTimeout(() => {
      entry.settleTimer = null;
      if (entries.get(deps.slot(entry.sessionKey)) !== entry) return;
      let busy = false;
      try {
        busy = typeof deps.isBusy === "function" && deps.isBusy(entry.sessionKey) === true;
      } catch (_) {
        busy = false;
      }

      if (busy) return;
      void finish(entry);
    }, settleMs));
  }

  async function finish(entry            ) {
    if (entries.get(deps.slot(entry.sessionKey)) !== entry) return;
    clearTimers(entry);
    entries.delete(deps.slot(entry.sessionKey));
    log("card_build_turn_end", {});

    if (entry.buildKey && typeof deps.released === "function") {
      try {
        deps.released(entry.buildKey);
      } catch (_) {

      }
    }
    await restore(entry);
  }

  async function restore(entry            ) {
    if (!entry.fastOn) return;
    entry.fastOn = false;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      if (attempt > 0) await wait(retryMs);
      try {
        const result = await deps.setFastMode(entry.sessionKey, false);
        ok = !!result && result.status === "accepted";
      } catch (_) {
        ok = false;
      }
    }
    log("card_build_turn_restored", { ok });
  }

  function onTurnChanged(event                                         ) {
    if (!event || event.busy !== false || typeof event.sessionKey !== "string") return;
    const entry = entries.get(deps.slot(event.sessionKey));
    if (!entry) return;
    if (entry.phase === "ask") {
      if (stale(entry)) {
        drop(entry, "stale");
        return;
      }
      void startBuild(entry);
    } else if (entry.phase === "build") {
      settle(entry);
    }
  }

  function startCardTurn(sessionKey        ) {
    const slot = deps.slot(sessionKey);
    if (entries.has(slot)) return;
    const entry             = {
      sessionKey,
      title: null,
      phase: "build",
      plannedAt: now(),
      startedAt: now(),
      fastOn: true,
      yesUnspent: null,
      askRunId: null,
      buildKey: null,
      settleTimer: null,
      maxTimer: null,
      cardTurn: true,
    };
    entry.maxTimer = unref(setTimeout(() => {
      entry.maxTimer = null;
      log("card_build_turn_overran", { card_turn: true });
      void finish(entry);
    }, CARD_BUILD_TURN_MAX_MS));
    entries.set(slot, entry);
    log("card_build_turn_start", { fast: true, card_turn: true });
  }

  async function beforeTurn(sessionKey        , cardWork         ) {
    try {
      if (!sessionKey || cardWork !== true || deps.enabled() !== true) return false;
      if (entries.has(deps.slot(sessionKey))) return false;
      const config = await deps.sessionConfig(sessionKey);
      if (!config || config.fastMode === true || config.fastModeSupported !== true) return false;
      const switched = Promise.resolve(deps.setFastMode(sessionKey, true)).then(
        (result) => {
          const ok = !!result && result.status === "accepted";

          if (ok) startCardTurn(sessionKey);
          return ok;
        },
        () => false,
      );
      let timer                                       = null;
      const timeout = new Promise         ((resolve) => {
        timer = unref(setTimeout(() => resolve(false), CARD_TURN_SWITCH_WAIT_MS));
      });
      const ok = await Promise.race([switched, timeout]);
      if (timer) clearTimeout(timer);
      return ok;
    } catch (_) {
      return false;
    }
  }

  return {
    plan,
    beforeTurn,
    carriesBuild,
    onTurnChanged,

    phase: (sessionKey        ) => entries.get(deps.slot(sessionKey))?.phase || null,
  };
}

module.exports = { CARD_BUILD_TURN_IDEMPOTENCY_PREFIX, CARD_BUILD_TURN_ASK_TTL_MS, CARD_BUILD_TURN_LATE_END_MS, CARD_BUILD_TURN_MAX_MS, CARD_TURN_SWITCH_WAIT_MS, cardBuildTurnMessage, createCardBuildTurns };
