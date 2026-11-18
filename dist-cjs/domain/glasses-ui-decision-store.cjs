const { createHash } = require("node:crypto");
const { frameFacts, JEV_MODEL_ID, JEV_QUESTIONS, JEV_ROUND, JEV_ROUND_5, JEV_ROUND_5_QUESTIONS } = require("./glasses-ui-surface-decision.cjs");
const { TITLE_ICON_QUESTIONS, titleIconOf } = require("./glasses-ui-title-icons.cjs");
const { JEV_CARD_QUESTIONS } = require("./glasses-ui-jev-card.cjs");

const DEFAULT_MAX_AGE_MS = 30_000;

const SKIP_UNKNOWN = Object.freeze({ decision: null, reason: "unknown", ms: null });

const MAX_FRAMED_RUNS = 64;

function hashWearerText(text     ) {
  return createHash("sha256")
    .update(typeof text === "string" ? text.trim() : "")
    .digest("hex");
}

function waitForResult(entry     , ms     )                {
  if (entry.result || !Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve();
    }, ms);
    entry.landed.then(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

function connectionFacts(entry     , settled     ) {
  const reused = settled && typeof settled.socketReused === "boolean" ? settled.socketReused : null;
  return { warm: entry.warm, socketReused: reused };
}

function roundFacts(entry     , settled     , decision     ) {
  const source = decision && decision.decision ? decision.decision : settled;
  const frame = source && typeof source.frame === "string" ? source.frame : null;
  const frameConfidence = frame !== null && Number.isFinite(source.frameConfidence) ? source.frameConfidence : null;
  return { round: entry.round, frame, frameConfidence, ...(entry.cardAsked ? { cardAsked: true } : {}) };
}

function createSurfaceDecisionStore(options      = {}) {
  const opts = options || {};
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const emit = typeof opts.emit === "function" ? opts.emit : null;
  const bySession = new Map();

  const framedRuns = new Map                ();

  const iconRuns = new Map                ();

  function rememberFramedRun(runId        , frame        ) {
    framedRuns.delete(runId);
    framedRuns.set(runId, frame);
    if (framedRuns.size > MAX_FRAMED_RUNS) framedRuns.delete(framedRuns.keys().next().value          );
  }

  function rememberIconRun(runId        , icon        ) {
    iconRuns.delete(runId);
    iconRuns.set(runId, icon);
    if (iconRuns.size > MAX_FRAMED_RUNS) iconRuns.delete(iconRuns.keys().next().value          );
  }

  function sweepExpired() {
    const cutoff = now() - DEFAULT_MAX_AGE_MS;
    for (const [key, entry] of bySession) {
      if (entry.recordedAt < cutoff) bySession.delete(key);
    }
  }

  function recordPendingDecision(sessionKey     , pending     ) {
    if (!sessionKey || !pending || !pending.promise) return;
    sweepExpired();
    const entry      = {
      sessionKey,
      turnId: pending.turnId || null,
      textHash: pending.textHash || null,
      result: null,
      landed: null,
      emitted: false,
      keylessApplied: false,

      warm: typeof pending.warm === "boolean" ? pending.warm : null,

      round: Number.isInteger(pending.round) ? pending.round : null,

      cardAsked: pending.cardAsked === true,

      runIds: []            ,
      frame: null                 ,

      icon: null                 ,
      recordedAt: now(),
    };

    if (pending.iconPromise) {
      Promise.resolve(pending.iconPromise).then(
        (icon) => {
          if (typeof icon !== "string" || !icon) return;
          entry.icon = icon;
          for (const runId of entry.runIds) rememberIconRun(runId, icon);
        },
        () => {},
      );
    }

    entry.landed = Promise.resolve(pending.promise).then(
      (value) => {
        if (!entry.result) entry.result = value && typeof value === "object" ? value : SKIP_UNKNOWN;
      },
      () => {
        if (!entry.result) entry.result = SKIP_UNKNOWN;
      },
    );
    bySession.set(sessionKey, entry);
  }

  function has(sessionKey     ) {
    return bySession.has(sessionKey);
  }

  function emitOnce(entry     , payload     ) {
    if (!emit || entry.emitted) return;
    entry.emitted = true;
    emit(payload, entry.sessionKey);
  }

  async function takeDecisionForPrompt(sessionKey     , query      = {}) {
    const q = query || {};
    let key = null;
    if (sessionKey && bySession.has(sessionKey)) {
      key = sessionKey;
    } else if (Array.isArray(q.fallbackKeys)) {
      key = q.fallbackKeys.find((alt     ) => alt && bySession.has(alt)) || null;
    }
    if (!key) return null;
    const entry = bySession.get(key);

    const turnId = q.turnId || null;
    const textHash = typeof q.text === "string" ? hashWearerText(q.text) : q.textHash || null;

    const textHashes = [
      ...(textHash !== null ? [textHash] : []),
      ...(Array.isArray(q.texts) ? q.texts.filter((t     ) => typeof t === "string").map(hashWearerText) : []),
    ];

    const turnMismatch = turnId !== null && entry.turnId !== null && turnId !== entry.turnId;
    const textMismatch = textHashes.length > 0 && entry.textHash !== null && !textHashes.includes(entry.textHash);
    if (turnMismatch || textMismatch) {

      bySession.delete(key);
      return null;
    }

    const keyless = turnId === null && textHashes.length === 0;
    if (keyless && entry.keylessApplied) return null;
    const maxAgeMs = Number.isFinite(q.maxAgeMs) ? q.maxAgeMs : DEFAULT_MAX_AGE_MS;
    if (now() - entry.recordedAt > maxAgeMs) {
      bySession.delete(key);
      return null;
    }

    const waitStartedAt = now();
    if (!entry.result) {
      const budgetMs = Number.isFinite(q.budgetMs) ? q.budgetMs : 800;

      const remaining = Number.isFinite(q.remainingMs) ? q.remainingMs : budgetMs - (now() - entry.recordedAt);

      await waitForResult(entry, Number.isFinite(q.maxWaitMs) ? Math.min(remaining, q.maxWaitMs) : remaining);
      if (!entry.result) entry.result = { decision: null, reason: "budget_expired", ms: null };
    }

    const settled = entry.result;
    const waitMs = Math.max(0, now() - waitStartedAt);
    const judged = (settled && settled.decision) || null;
    if (!judged) {
      emitOnce(entry, {
        outcome: "skipped",
        skipReason: (settled && settled.reason) || "unknown",
        ms: (settled && settled.ms) || null,
        shape: null,
        kind: null,
        slot: null,
        confidence: null,
        waitMs,
        cardApplied: false,
        line: null,
        ...roundFacts(entry, settled, null),
        ...connectionFacts(entry, settled),
      });
      return null;
    }

    let decision = judged;
    if (typeof q.restyle === "function") {
      try {
        decision = q.restyle(judged) || judged;
      } catch (_) {
        decision = judged;
      }
    }
    if (keyless) entry.keylessApplied = true;

    if (decision.decision.line === "v2_framed" && typeof decision.decision.frame === "string") {
      entry.frame = decision.decision.frame;
      for (const runId of entry.runIds) rememberFramedRun(runId, entry.frame);
    }
    emitOnce(entry, {
      outcome: "applied",
      skipReason: null,
      ms: settled.ms || null,
      shape: decision.decision.shape,
      kind: decision.decision.kind,
      slot: decision.decision.slot,
      confidence: decision.decision.confidence,
      waitMs,
      cardApplied: decision.decision.cardApplied === true,
      line: typeof decision.decision.line === "string" ? decision.decision.line : null,
      ...roundFacts(entry, settled, decision),
      ...connectionFacts(entry, settled),
    });
    return decision;
  }

  function forgetSession(sessionKey     ) {
    bySession.delete(sessionKey);
  }

  function noteRun(sessionKey     , turnId     , runId     ) {
    if (!sessionKey || !turnId || typeof runId !== "string" || !runId) return;
    const entry = bySession.get(sessionKey);
    if (!entry || entry.turnId !== turnId || entry.runIds.includes(runId)) return;
    entry.runIds.push(runId);
    if (entry.frame) rememberFramedRun(runId, entry.frame);
    if (entry.icon) rememberIconRun(runId, entry.icon);
  }

  function decidedFrame(runId     )                {
    return typeof runId === "string" ? framedRuns.get(runId) ?? null : null;
  }

  function decidedIcon(runId     )                {
    return typeof runId === "string" ? iconRuns.get(runId) ?? null : null;
  }

  return {
    recordPendingDecision,
    takeDecisionForPrompt,
    forgetSession,
    noteRun,
    decidedFrame,
    decidedIcon,
    has,
    size: () => bySession.size,
  };
}

function createSurfaceDecisionFirer(deps      = {}) {
  const config = deps.config && typeof deps.config === "object" ? deps.config : {};
  const store = deps.store;
  let client      = null;

  function resolveClient() {
    if (client) return client;
    client = deps.createClient({
      apiKey: config.apiKey || "",
      enabled: config.enabled === true,
      model: (typeof config.model === "string" && config.model) || JEV_MODEL_ID,
      questions: JEV_ROUND_5_QUESTIONS,

      ...(deps.connection ? { connection: deps.connection } : {}),
    });
    return client;
  }

  const fireSurfaceDecision      = function fireSurfaceDecision(sessionKey     , text     , turnId     ) {
    if (config.enabled !== true) return false;
    if (!store || !sessionKey) return false;
    if (typeof text !== "string" || !text.trim()) return false;
    const jev = resolveClient();
    if (!jev || !jev.hasKey) return false;
    const budgetMs = Number.isFinite(config.budgetMs) ? config.budgetMs : 800;
    let promise;
    let iconPromise = null;
    let warm = null;
    let round = JEV_ROUND_5;
    let cardAsked = false;
    try {

      if (deps.connection && typeof deps.connection.isWarm === "function") {
        warm = deps.connection.isWarm() === true;
      }

      let v2Turn = false;
      try {
        v2Turn = typeof deps.v2Turn === "function" && deps.v2Turn(sessionKey) === true;
      } catch (_) {
        v2Turn = false;
      }
      round = v2Turn ? JEV_ROUND : JEV_ROUND_5;

      try {
        cardAsked = v2Turn && typeof deps.cardTurn === "function" && deps.cardTurn(sessionKey) === true;
      } catch (_) {
        cardAsked = false;
      }
      const questions = cardAsked ? JEV_CARD_QUESTIONS : v2Turn ? JEV_QUESTIONS : JEV_ROUND_5_QUESTIONS;

      const state = deps.buildState({ wearerSaid: text, lastSurface: null });
      promise = Promise.resolve(jev.decide(state, { budgetMs, turnId, questions }))
        .then((result     ) => {
          const socketReused = result && typeof result.socketReused === "boolean" ? result.socketReused : null;
          if (!result || result.ok !== true) {
            return { decision: null, reason: (result && result.reason) || "unknown", ms: result && result.ms, socketReused };
          }
          const decision = deps.compose(result.answers);

          return {
            decision,
            reason: decision ? null : "below_floor",
            ms: result.ms,
            socketReused,
            ...frameFacts(result.answers),
          };
        })

        .catch(() => ({ decision: null, reason: "unknown", ms: null }));
      iconPromise = v2Turn && titleIconsOn(sessionKey) ? askTitleIcon(jev, sessionKey, state, budgetMs, turnId, promise) : null;
    } catch (_) {
      return false;
    }
    store.recordPendingDecision(sessionKey, {
      turnId: turnId || null,
      textHash: hashWearerText(text),
      promise,
      iconPromise,
      warm,
      round,
      cardAsked,
    });
    return true;
  };

  fireSurfaceDecision.reset = () => {
    client = null;
  };
  return fireSurfaceDecision;

  function titleIconsOn(sessionKey     ) {
    try {
      return typeof deps.titleIcons === "function" && deps.titleIcons(sessionKey) === true;
    } catch (_) {
      return false;
    }
  }

  function askTitleIcon(jev     , sessionKey     , state     , budgetMs     , turnId     , decided              ) {
    const emitIcon = typeof deps.emitIcon === "function" ? deps.emitIcon : null;
    const report = (payload     ) => {
      if (!emitIcon) return;
      try {
        emitIcon(payload, sessionKey);
      } catch (_) {

      }
    };
    return decided
      .then((settled     ) => {
        const line = settled && settled.decision && settled.decision.decision ? settled.decision.decision.line : null;
        if (line !== "render") return null;
        return Promise.resolve(jev.decide(state, { budgetMs, turnId, questions: TITLE_ICON_QUESTIONS })).then((result     ) => {
          if (!result || result.ok !== true) {
            report({ outcome: "failed", skipReason: (result && result.reason) || "unknown", icon: null, confidence: null, ms: (result && result.ms) || null });
            return null;
          }
          const icon = titleIconOf(result.answers);
          const answer = result.answers && result.answers.icon;
          const confidence = answer && Number.isFinite(answer.confidence) ? answer.confidence : null;
          report({ outcome: icon ? "picked" : "none", skipReason: null, icon, confidence, ms: result.ms || null });
          return icon;
        });
      })
      .catch(() => null);
  }
}

module.exports = { hashWearerText, createSurfaceDecisionStore, createSurfaceDecisionFirer };
