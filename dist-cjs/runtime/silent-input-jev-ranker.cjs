const { letterGroup, normalizeWays, patternCompatible } = require("./input-prediction-shared.cjs");

const SILENT_INPUT_JEV_MAX_OPTIONS = 255;

const SILENT_INPUT_JEV_QUESTIONS_PER_GROUP = 4;

const SILENT_INPUT_JEV_BLEND = 1;

const SILENT_INPUT_JEV_MAX_RANKED = 96;

const LAMBDA = 0.7;

const SUPPLIED_FLOOR = 1e-5;

function rankFloor(index) {
  return 1 / (1e6 + index * 1e3);
}

const SILENT_INPUT_JEV_INSTRUCTIONS =
  "`message_so_far` is the beginning of a short chat message a person is typing" +
  " (when `replying_to` is present, it is the message they are answering)." +
  " Which one of these words is most likely to be the very next word they type?";

const WORD_RE = /^[A-Za-z]{1,31}$/;

function previousKey(contextSuffix) {
  const text = String(contextSuffix || "");
  let end = text.length;
  while (end > 0 && text[end - 1] === " ") end -= 1;
  if (end === 0) return "";
  if (".!?".indexOf(text[end - 1]) !== -1) return "";
  let start = end;
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1;
  const token = text.slice(start, end);
  return WORD_RE.test(token) ? token.toLowerCase() : null;
}

function wordsOfText(text, cap) {
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 64;
  const out = [];
  const seen = new Set();
  const matches = String(text || "").match(/[A-Za-z]{1,31}/g) || [];
  for (const raw of matches) {
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

function rankSilentInputCandidates(tables, request) {
  const req = request && typeof request === "object" ? request : {};
  const ways = normalizeWays(req.ways);
  const pattern = typeof req.pattern === "string" ? req.pattern : "";
  const prev = previousKey(req.contextSuffix);

  const prevId = prev === null ? -1 : prev === "" ? 0 : tables.prevIdOfKey(prev);
  const row = prevId < 0 ? -1 : tables.rowOf(prevId);
  const rowStart = row >= 0 ? tables.pairs.rowStarts[row] : 0;
  const rowEnd = row >= 0 ? tables.pairs.rowStarts[row + 1] : 0;
  const followers = tables.pairs.followerWords;
  const probabilities = tables.pairs.probabilities;
  const scores = tables.scores;
  const words = tables.words;

  const out = [];
  const seen = new Set();

  let cursor = rowStart;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (pattern && !patternCompatible(word, pattern, ways)) continue;
    let bigram = 0;
    if (row >= 0) {
      while (cursor < rowEnd && followers[cursor] < i) cursor += 1;
      if (cursor < rowEnd && followers[cursor] === i) bigram = probabilities[cursor];
    }
    const unigram = scores[i];
    const score = (row >= 0 ? LAMBDA * bigram + (1 - LAMBDA) * unigram : unigram) + rankFloor(i);
    const key = tables.keys[i];
    seen.add(key);
    out.push({ word, key, score });
  }
  for (const supplied of suppliedWords(req)) {
    const key = supplied.toLowerCase();
    if (seen.has(key)) continue;
    if (pattern && !patternCompatible(supplied, pattern, ways)) continue;
    seen.add(key);
    out.push({ word: supplied, key, score: SUPPLIED_FLOOR });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function suppliedWords(req) {
  const out = [];
  for (const word of wordsOfText(req.replyingTo, 64)) out.push(word);
  const open = Array.isArray(req.openWords) ? req.openWords : [];
  for (const raw of open) {
    if (typeof raw === "string" && WORD_RE.test(raw)) out.push(raw);
    if (out.length >= 128) break;
  }
  return out;
}

function buildSilentInputJevGroups(ranked, pattern, ways, perGroup) {
  const per = Number.isFinite(perGroup) && perGroup >= 1 ? Math.floor(perGroup) : 1;
  const count = pattern ? 1 : normalizeWays(ways) === 3 ? 3 : 2;

  const byGroup = [];
  for (let i = 0; i < count; i += 1) byGroup.push([]);
  for (const entry of ranked) {
    const group = pattern ? 0 : letterGroup(entry.key[0], normalizeWays(ways));
    if (group >= 0 && group < count && byGroup[group].length < SILENT_INPUT_JEV_MAX_OPTIONS * per) {
      byGroup[group].push(entry);
    }
  }
  const questions = [];
  for (const entries of byGroup) {
    const dealt = [];
    for (let i = 0; i < per; i += 1) dealt.push([]);
    for (let i = 0; i < entries.length; i += 1) dealt[i % per].push(entries[i]);
    for (const question of dealt) if (question.length) questions.push(question);
  }
  return questions;
}

function buildSilentInputJevQuestions(groups) {
  const questions = {};
  groups.forEach((group, i) => {
    const criteria = {};
    for (const entry of group) criteria[entry.key] = null;
    questions[`g${i}`] = { type: "choice", instructions: SILENT_INPUT_JEV_INSTRUCTIONS, criteria };
  });
  return questions;
}

function buildSilentInputJevState(contextSuffix, replyingTo) {
  const state = { message_so_far: typeof contextSuffix === "string" ? contextSuffix : "" };
  if (typeof replyingTo === "string" && replyingTo) state.replying_to = replyingTo;
  return state;
}

function combineSilentInputJevAnswers(ranked, groups, answers, blend) {
  const weight = Number.isFinite(blend) ? blend : SILENT_INPUT_JEV_BLEND;
  const a = answers && typeof answers === "object" ? answers : {};
  for (let i = 0; i < groups.length; i += 1) {
    const answer = a[`g${i}`];
    if (!answer || !answer.probabilities || typeof answer.probabilities !== "object") {
      return { ok: false, reason: "no_answer" };
    }
  }
  let allMass = 0;
  for (const entry of ranked) allMass += entry.score;
  if (!(allMass > 0)) allMass = 1;
  let askedMass = 0;
  for (const group of groups) for (const entry of group) askedMass += entry.score;
  if (!(askedMass > 0)) askedMass = 1;

  const jevShare = new Map();
  groups.forEach((group, i) => {
    const probabilities = a[`g${i}`].probabilities;
    let groupMass = 0;
    for (const entry of group) groupMass += entry.score;
    if (!(groupMass > 0)) groupMass = 1;
    for (const entry of group) {
      const p = Number(probabilities[entry.key]);
      jevShare.set(entry.key, (Number.isFinite(p) ? p : 0) * (groupMass / askedMass));
    }
  });

  const scored = ranked.map((entry) => ({
    word: entry.word,
    key: entry.key,
    final:
      Math.pow(Math.max(jevShare.get(entry.key) || 0, 1e-9), weight) *
      Math.pow(Math.max(entry.score / allMass, 1e-9), 1 - weight),
  }));
  scored.sort((x, y) => y.final - x.final);
  return { ok: true, ranked: scored };
}

function topSilentInputWords(scored, limit) {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SILENT_INPUT_JEV_MAX_RANKED;
  const head = scored.slice(0, cap);
  let total = 0;
  for (const entry of head) total += entry.final;
  if (!(total > 0)) total = 1;
  return {
    words: head.map((entry) => entry.word),
    probabilities: head.map((entry) => entry.final / total),
  };
}

module.exports = { SILENT_INPUT_JEV_MAX_OPTIONS, SILENT_INPUT_JEV_QUESTIONS_PER_GROUP, SILENT_INPUT_JEV_BLEND, SILENT_INPUT_JEV_MAX_RANKED, SILENT_INPUT_JEV_INSTRUCTIONS, wordsOfText, rankSilentInputCandidates, buildSilentInputJevGroups, buildSilentInputJevQuestions, buildSilentInputJevState, combineSilentInputJevAnswers, topSilentInputWords };
