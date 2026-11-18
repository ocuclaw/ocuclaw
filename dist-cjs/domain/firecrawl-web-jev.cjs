const { createHash } = require("node:crypto");
const { JEV_MODEL_ID } = require("./glasses-ui-surface-decision.cjs");

const WEB_JEV_ROUND = "web-1";

const yesNo = (question        , yes     , no     ) => ({
  type: "noul",
  instructions: { question, inspect: "wearer_said" },
  criteria: { true: yes, false: no },
});

const WEB_JEV_QUESTIONS = {
  needs_web: yesNo(
    "Does answering this well need facts from the web right now, rather than what an assistant already knows or can work out?",
    {
      what: "Current or changing facts: news, scores, prices, opening hours, schedules, weather, releases, or a specific page, product or place to look up",
      examples: ["when do the Giants play tonight", "what's the price of a flight to Lisbon next week", "is the ferry running today"],
    },
    {
      what: "General knowledge, advice, writing, maths, a chat, or a task on the wearer's own things (notes, timers, cards, settings)",
      examples: ["why do cats knead", "write a toast for my brother", "set a timer for ten minutes"],
    },
  ),
  standalone: yesNo(
    "Do the words alone say what to look up, without needing earlier messages?",
    {
      what: "Names the subject itself",
      examples: ["Lisbon weather tomorrow", "latest iPhone release date"],
    },
    {
      what: "Leans on something said before",
      examples: ["what about tomorrow?", "and the other one?", "is it open now"],
    },
  ),
  freshness: {
    type: "choice",
    instructions: { question: "How fresh must the facts be?", inspect: "wearer_said" },
    criteria: {
      live: "changing by the minute: live scores, stock prices, delays, departures",
      today: "today's news, events or hours",
      recent: "this week or month: recent releases, reviews, results",
      timeless: "stable facts that rarely change",
    },
  },
  source: {
    type: "choice",
    instructions: { question: "Where would the answer best come from?", inspect: "wearer_said" },
    criteria: {
      web: "ordinary web pages: shops, places, guides, official sites",
      news: "news reports",
      research: "papers and studies",
      developer: "code, libraries, documentation, issues",
      gov: "laws, rules and government pages",
      data: "a typed number or record: a score, a price, a rate, a listing",
    },
  },
  depth: {
    type: "choice",
    instructions: { question: "How much reading does a good answer take?", inspect: "wearer_said" },
    criteria: {
      glance: "one fact",
      read: "a page or two",
      research: "many sources compared over minutes",
    },
  },
  watch_target: {
    type: "choice",
    instructions: {
      question: "If the wearer asks to be told when something changes, what is to be watched?",
      inspect: "wearer_said",
    },
    criteria: {
      none: "nothing: a one-off question",
      page: "one page",
      field: "one value on a page: a price, a date, a stock level",
      site: "a whole site or section",
      new_results: "new results for a search",
      report: "a regular summary",
    },
  },
};

const WEB_JEV_DIGEST = `sha256:${createHash("sha256").update(JSON.stringify(WEB_JEV_QUESTIONS)).digest("hex")}`;

const CHOICE_KEYS = ["freshness", "source", "depth", "watch_target"];
const NOUL_KEYS = ["needs_web", "standalone"];

const score = (v     ) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? Math.round(v * 1000) / 1000 : null);

function camel(key        ) {
  return key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}

function webJevFacts(answers     ) {
  const a = answers && typeof answers === "object" ? answers : {};
  const facts                      = {};
  for (const key of NOUL_KEYS) facts[camel(key)] = score(a[key] && a[key].noul);
  for (const key of CHOICE_KEYS) {
    const answer = a[key];
    const allowed = Object.keys((WEB_JEV_QUESTIONS       )[key].criteria);
    const choice = answer && typeof answer.choice === "string" && allowed.includes(answer.choice) ? answer.choice : null;
    facts[camel(key)] = choice;
    facts[`${camel(key)}Confidence`] = choice ? score(answer.confidence) : null;
  }
  return facts;
}

const WEB_INTENT_KIND                         = {
  "search.web": "search",
  "network.fetch": "read",
  "browser.browse": "browse",
  "browser.navigate": "browse",
  "browser.fill": "browse",
};

const MAX_PENDING_TURNS = 32;

const TURN_TTL_MS = 10 * 60_000;

function createWebJevShadow(deps      = {}) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const budgetMs = Number.isFinite(deps.budgetMs) ? deps.budgetMs : 3000;
  const turns = new Map             ();
  const byRun = new Map             ();
  let client      = null;
  let clientKey                = null;

  function resolveClient(apiKey        ) {
    if (client && clientKey === apiKey) return client;
    client = deps.createClient({
      apiKey,
      enabled: true,
      model: JEV_MODEL_ID,
      questions: WEB_JEV_QUESTIONS,
      ...(deps.connection ? { connection: deps.connection } : {}),
    });
    clientKey = apiKey;
    return client;
  }

  function sweep() {
    const cutoff = now() - TURN_TTL_MS;
    for (const [id, turn] of turns) {
      if (turn.firedAt < cutoff || turns.size > MAX_PENDING_TURNS) {
        turns.delete(id);
        if (turn.runId) byRun.delete(turn.runId);
      }
    }
  }

  function fire(sessionKey     , text     , turnId     ) {
    try {
      if (typeof deps.enabled !== "function" || deps.enabled() !== true) return false;
      if (!sessionKey || typeof turnId !== "string" || !turnId) return false;
      if (typeof text !== "string" || !text.trim()) return false;
      const apiKey = typeof deps.apiKey === "function" ? deps.apiKey() : "";
      if (typeof apiKey !== "string" || !apiKey) return false;
      const jev = resolveClient(apiKey);
      if (!jev || !jev.hasKey) return false;
      sweep();
      const turn      = {
        sessionKey,
        turnId,
        runId: null,
        firedAt: now(),
        settled: null,
        web: { search: 0, read: 0, browse: 0 },
        firstWebMs: null,
        seenActivityIds: new Set        (),
      };
      turns.set(turnId, turn);
      const state = deps.buildState({ wearerSaid: text, lastSurface: null });
      Promise.resolve(jev.decide(state, { budgetMs, turnId, questions: WEB_JEV_QUESTIONS }))
        .then((result     ) => {
          turn.settled = result && result.ok === true
            ? { outcome: "answered", skipReason: null, ms: result.ms ?? null, ...webJevFacts(result.answers) }
            : { outcome: "failed", skipReason: (result && result.reason) || "unknown", ms: (result && result.ms) ?? null };
        })
        .catch(() => {
          turn.settled = { outcome: "failed", skipReason: "unknown", ms: null };
        })
        .then(() => {
          if (turn.ended) report(turn);
        });
      return true;
    } catch (_) {
      return false;
    }
  }

  function noteRun(sessionKey     , turnId     , runId     ) {
    const turn = typeof turnId === "string" ? turns.get(turnId) : null;
    if (!turn || turn.sessionKey !== sessionKey || turn.runId || typeof runId !== "string" || !runId) return;
    turn.runId = runId;
    byRun.set(runId, turn);
  }

  function observeActivity(activity     , turnEnded         ) {
    try {
      const runId = activity && typeof activity.runId === "string" ? activity.runId : null;
      const turn = runId ? byRun.get(runId) : null;
      if (!turn) return;
      const kind = WEB_INTENT_KIND[activity.intent];
      const toolStart = activity.origin === "tool" && activity.toolPhase === "start";
      const activityId = typeof activity.activityId === "string" ? activity.activityId : null;
      if (kind && toolStart && !(activityId && turn.seenActivityIds.has(activityId))) {
        if (activityId) turn.seenActivityIds.add(activityId);
        turn.web[kind] += 1;
        if (turn.firstWebMs === null) turn.firstWebMs = now() - turn.firedAt;
      }
      if (turnEnded) {
        turn.ended = true;
        turn.runMs = now() - turn.firedAt;
        if (turn.settled) report(turn);
      }
    } catch (_) {

    }
  }

  function report(turn     ) {
    if (turn.reported) return;
    turn.reported = true;
    turns.delete(turn.turnId);
    if (turn.runId) byRun.delete(turn.runId);
    const webCalls = turn.web.search + turn.web.read + turn.web.browse;
    const row = {
      round: WEB_JEV_ROUND,
      digest: WEB_JEV_DIGEST.slice(0, 19),
      ...turn.settled,
      usedWeb: webCalls > 0,
      webCalls,
      webSearches: turn.web.search,
      webReads: turn.web.read,
      webBrowses: turn.web.browse,
      firstWebMs: turn.firstWebMs,
      runMs: turn.runMs ?? null,
    };
    try {
      if (typeof deps.emit === "function") deps.emit(row, turn.sessionKey, turn.runId);
    } catch (_) {

    }
  }

  return { fire, noteRun, observeActivity, size: () => turns.size };
}

module.exports = { WEB_JEV_ROUND, WEB_JEV_QUESTIONS, WEB_JEV_DIGEST, webJevFacts, createWebJevShadow };
