const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord } = require("../tools/glasses-ui-library.cjs");

const PROGRAM_CARD_REVIEW_PACE_FILE = ".pace.json";

const PROGRAM_CARD_REVIEW_PACE_SAMPLES = 8;

const PROGRAM_CARD_REVIEW_PACE_MARGIN = 1.5;

const PROGRAM_CARD_REVIEW_PACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const PROGRAM_CARD_REVIEW_DEADLINE_CAPS = Object.freeze({
  glance: 120_000,
  outline: 300_000,
  detail: 240_000,
  fix: 240_000,
});
const STAGES = Object.keys(PROGRAM_CARD_REVIEW_DEADLINE_CAPS);
const ROUTE_MAX = 200;

function programCardReviewRoute(res     ) {
  const model = typeof res?.model === "string" ? res.model.trim() : "";
  if (!model) return "";
  const provider = typeof res?.provider === "string" ? res.provider.trim() : "";
  const route = provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
  return route.slice(0, ROUTE_MAX);
}

function cleanSamples(raw     ) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s     ) => s && Number.isSafeInteger(s.ms) && s.ms > 0 && Number.isSafeInteger(s.at))
    .slice(-PROGRAM_CARD_REVIEW_PACE_SAMPLES)
    .map((s     ) => ({ ms: s.ms, at: s.at, ...(s.timedOut === true ? { timedOut: true } : {}) }));
}

function createProgramCardReviewPace(opts      = {}) {
  const fs = opts.fs;
  const libraryDir = opts.libraryDir;
  const file = path.join(opts.root, PROGRAM_CARD_REVIEW_PACE_FILE);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();
  const log = typeof opts.log === "function" ? opts.log : () => {};
  let route = "";
  let stages      = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved && saved.version === 1 && saved.stages && typeof saved.stages === "object") {
      route = typeof saved.route === "string" ? saved.route.slice(0, ROUTE_MAX) : "";
      for (const stage of STAGES) stages[stage] = cleanSamples(saved.stages[stage]);
    }
  } catch {  }

  function samples(stage        ) {
    const oldest = now() - PROGRAM_CARD_REVIEW_PACE_MAX_AGE_MS;
    return (stages[stage] || []).filter((s     ) => s.at >= oldest);
  }

  function deadline(stage        , baseMs        ) {
    const cap = Math.max(baseMs, (PROGRAM_CARD_REVIEW_DEADLINE_CAPS       )[stage] || baseMs);
    const slowest = samples(stage).reduce((max        , s     ) => Math.max(max, s.ms), 0);
    return Math.min(cap, Math.max(baseMs, Math.ceil(slowest * PROGRAM_CARD_REVIEW_PACE_MARGIN)));
  }

  function record(stage        , ms        , { answeredBy = "", timedOut = false }      = {}) {
    if (!STAGES.includes(stage) || !Number.isFinite(ms) || ms < 1) return;
    if (answeredBy && answeredBy !== route) {
      if (route) log(`review pace reset: route ${route} -> ${answeredBy}`);
      route = answeredBy;
      stages = {};
    }
    stages[stage] = [...samples(stage), { ms: Math.round(ms), at: now(), ...(timedOut ? { timedOut: true } : {}) }]
      .slice(-PROGRAM_CARD_REVIEW_PACE_SAMPLES);
    try {
      atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: file, record: { version: 1, route, stages } });
    } catch { log("review pace could not be retained"); }
  }

  return { deadline, record, route: () => route };
}

module.exports = { PROGRAM_CARD_REVIEW_PACE_FILE, PROGRAM_CARD_REVIEW_PACE_SAMPLES, PROGRAM_CARD_REVIEW_PACE_MARGIN, PROGRAM_CARD_REVIEW_PACE_MAX_AGE_MS, PROGRAM_CARD_REVIEW_DEADLINE_CAPS, programCardReviewRoute, createProgramCardReviewPace };
