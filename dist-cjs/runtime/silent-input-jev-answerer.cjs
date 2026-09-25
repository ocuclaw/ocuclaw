const { createJevClient } = require("../domain/glasses-ui-jev-client.cjs");
const { predictionResult } = require("./input-prediction-shared.cjs");
const { SILENT_INPUT_JEV_BLEND, SILENT_INPUT_JEV_MAX_RANKED, SILENT_INPUT_JEV_QUESTIONS_PER_GROUP, buildSilentInputJevGroups, buildSilentInputJevQuestions, buildSilentInputJevState, combineSilentInputJevAnswers, rankSilentInputCandidates, topSilentInputWords } = require("./silent-input-jev-ranker.cjs");
const { silentInputTables } = require("./silent-input-word-tables.cjs");

const SILENT_INPUT_JEV_MODEL = "jev-latest";
const SILENT_INPUT_JEV_PROVIDER = "typesafe";

const SILENT_INPUT_JEV_REASONS = Object.freeze(["no_candidates", "no_answer"]);

function createSilentInputJevAnswerer(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const config = o.config && typeof o.config === "object" ? o.config : {};
  if (config.enabled !== true) return null;
  const apiKey = typeof config.apiKey === "string" ? config.apiKey : "";
  if (!apiKey) return null;
  const makeClient = typeof o.createClient === "function" ? o.createClient : createJevClient;
  const loadTables = typeof o.tables === "function" ? o.tables : silentInputTables;
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const budgetMs = Number.isFinite(config.budgetMs) ? config.budgetMs : 2500;
  const perGroup = Number.isFinite(config.questionsPerGroup)
    ? Math.max(1, Math.floor(config.questionsPerGroup))
    : SILENT_INPUT_JEV_QUESTIONS_PER_GROUP;
  const blend = Number.isFinite(config.blend) ? config.blend : SILENT_INPUT_JEV_BLEND;
  const client = makeClient({
    apiKey,
    enabled: true,
    model: SILENT_INPUT_JEV_MODEL,
    fetchImpl: o.fetchImpl,
  });

  try {
    loadTables();
  } catch (_) {

  }

  async function answer(req, context, options) {
    const startedAt = now();
    const ctx = context && typeof context === "object" ? context : {};
    const tables = loadTables();
    const ranked = rankSilentInputCandidates(tables, {
      contextSuffix: req.contextSuffix,
      pattern: req.pattern,
      ways: req.ways,
      replyingTo: ctx.replyingTo,
      openWords: ctx.openWords,

      candidateSchema: ctx.candidateSchema,
    });
    if (!ranked.length) {
      return failure("no_candidates", now() - startedAt, 0);
    }

    const callPerGroup = options && Number.isFinite(options.perGroup) && options.perGroup >= 1
      ? Math.floor(options.perGroup)
      : perGroup;
    const groups = buildSilentInputJevGroups(ranked, req.pattern, req.ways, callPerGroup);
    const questions = buildSilentInputJevQuestions(groups);
    const state = buildSilentInputJevState(req.contextSuffix, ctx.replyingTo);
    const signal = options && typeof options === "object" ? options.signal : null;
    const decision = await client.decide(state, { budgetMs, questions, signal });
    const elapsedMs = Math.round(now() - startedAt);
    if (!decision.ok) {
      return failure(decision.reason, elapsedMs, groups.length);
    }
    const combined = combineSilentInputJevAnswers(ranked, groups, decision.answers, blend);
    if (!combined.ok) {
      return failure(combined.reason, elapsedMs, groups.length);
    }
    const top = topSilentInputWords(combined.ranked, SILENT_INPUT_JEV_MAX_RANKED);
    return predictionResult("ready", {

      candidates: top.words.slice(0, Math.max(1, Number(req.maxCandidates) || 8)),
      rankedWords: top.words,
      rankedScores: top.probabilities,
      provider: SILENT_INPUT_JEV_PROVIDER,
      model: SILENT_INPUT_JEV_MODEL,
      elapsedMs,
      usage: null,
      jevQuestions: groups.length,
      jevAsked: groups.reduce((sum, group) => sum + group.length, 0),
    });
  }

  function failure(reason, elapsedMs, questionCount) {
    return predictionResult("unavailable", {
      reason: `jev:${reason}`,
      elapsedMs: Math.round(elapsedMs),
      provider: SILENT_INPUT_JEV_PROVIDER,
      model: SILENT_INPUT_JEV_MODEL,
      jevQuestions: questionCount,
    });
  }

  return { answer, provider: SILENT_INPUT_JEV_PROVIDER, model: SILENT_INPUT_JEV_MODEL };
}

module.exports = { SILENT_INPUT_JEV_MODEL, SILENT_INPUT_JEV_PROVIDER, SILENT_INPUT_JEV_REASONS, createSilentInputJevAnswerer };
