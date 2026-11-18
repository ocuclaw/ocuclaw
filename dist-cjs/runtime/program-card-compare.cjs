const { compareLookReports, programCardLineVerdict, validateLookReport } = require("../tools/program-card-look.cjs");
const { provesVerdicts } = require("../tools/program-card-host-test.cjs");
const { normalizeProgramCardAsks } = require("../tools/glasses-ui-library.cjs");
const { isRetiredLookProblem } = require("../tools/program-card-retired-problems.cjs");

const REGRESSIONS_MAX = 20;

const COST_RATIO = 1.5;
const COST_FLOOR                         = { batteryPerMinute: 30, g2ms: 300 };

const PROGRAM_CARD_GAME_UNFIT_LOOK_CODES = Object.freeze(["main_value_not_biggest", "main_value_top_right"]);

const MET = new Set(["passed", "fixed"]);

function costOf(left     , right     ) {
  let worst      = null;
  for (const metric of Object.keys(COST_FLOOR)) {
    const before = left[metric], after = right[metric];
    if (!Number.isFinite(before) || !Number.isFinite(after) || after - before <= COST_FLOOR[metric]) continue;
    const ratio = before > 0 ? after / before : Infinity;
    if (ratio >= COST_RATIO && (!worst || ratio > worst.ratio)) worst = { metric, before, after, ratio };
  }
  return worst && { metric: worst.metric, before: worst.before, after: worst.after };
}

function summary(report     ) {
  const result      = { rebuild: 0, texts: 0, tiles: 0, g2ms: 0, wakes: 0, elapsedMs: 0 };
  for (const step of report?.steps || []) for (const key of Object.keys(result)) result[key] += Number(step[key]) || 0;
  if (Object.values(result).some((value     ) => !Number.isFinite(value))) return null;
  result.batteryPerMinute = result.elapsedMs > 0
    ? (result.wakes + result.rebuild + result.texts + result.tiles) * 60_000 / result.elapsedMs : null;
  if (result.batteryPerMinute !== null && !Number.isFinite(result.batteryPerMinute)) return null;
  result.pictures = (report?.pictures || []).map(({ step, after, hash }     ) => ({ step, after,
    ...(typeof hash === "string" ? { hash: hash.slice(0, 128) } : {}) }));
  const waitSteps = (report?.steps || []).filter((step     ) => step.do?.startsWith("wait:"));
  const frames = (waitSteps.length ? waitSteps : report?.steps || []).flatMap((step     ) =>
    Array.isArray(step.frameStages) ? step.frameStages : [step.stagesMedian ?? step.stages])
    .filter((value     ) => Number.isFinite(value) && value >= 0).sort((a        , b        ) => a - b);
  result.stages = Math.max(0, ...(report?.steps || []).map((step     ) => step.stages));
  const middle = Math.floor(frames.length / 2);
  result.stagesMedian = !frames.length ? 0 : frames.length % 2 ? frames[middle]
    : frames[middle - 1] + (frames[middle] - frames[middle - 1]) / 2;
  result.problems = (report?.problems || []).slice(0, 40).map(problemOf);
  return result;
}

function problemOf(problem     ) {
  return {
    code: typeof problem?.code === "string" ? problem.code.slice(0, 80) : "unknown",
    path: typeof problem?.path === "string" ? problem.path.slice(0, 160) : "",
    ...(typeof problem?.id === "string" ? { id: problem.id.slice(0, 80) } : {}),
    ...(problem?.rect && ["x", "y", "w", "h"].every((key) => Number.isFinite(problem.rect[key]))
      ? { rect: { x: problem.rect.x, y: problem.rect.y, w: problem.rect.w, h: problem.rect.h } } : {}),
    ...(typeof problem?.message === "string" ? { message: problem.message.slice(0, 200) } : {}),
    ...(Number.isInteger(problem?.step) ? { step: problem.step } : {}),
  };
}

function wordsOf(text        )           {
  return text.toLocaleLowerCase().split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}#]+$/gu, ""))
    .filter(Boolean);
}

function sameWord(promised        , shown        ) {
  if (!promised.includes("#")) return promised === shown;
  return promised.length === shown.length && [...promised].every((char, index) => char === "#" ? /\d/.test(shown[index]) : char === shown[index]);
}

function linesOf(report     , index        )                    {
  const step = report?.steps?.find((candidate     ) => candidate.index === index);
  if (!step || !Array.isArray(step.screen)) return null;
  return step.screen.flatMap((text     ) => typeof text === "string" ? text.split("\n") : [])
    .map(wordsOf).filter((line          ) => line.length);
}

function promiseOf(before     , after     , change     ) {
  const was = linesOf(before, change.step), now = linesOf(after, change.step);
  const words = [...new Set(wordsOf(change.shows))];
  if (!was || !now || !words.length) return "unknown";
  const on = (list          ) => (word        ) => list.some((shown) => sameWord(word, shown));
  const shown = on(now.flat()), had = on(was.flat());
  const added = words.filter((word) => !had(word));
  if (words.some((word) => had(word) && !shown(word)) || (added.length && !added.some(shown))) return "broken";
  const old = new Set(was.map((line) => line.join(" ")));
  return now.some((line) => !old.has(line.join(" ")) && words.some(on(line))) ? "kept" : "unchanged";
}

function programCardTestVerdicts(asks     , proves     , report     , before      = null) {
  const requirements           = normalizeProgramCardAsks(asks)?.requirements ?? [];
  if (!requirements.length || !proves || typeof proves !== "object" || !Object.keys(proves).length || !report ||
    report.ok === false || !Array.isArray(report.steps)) return null;
  const failed = new Set((Array.isArray(before) ? before : []).filter((test     ) => test?.verdict === "still_open")
    .map((test     ) => test.requirement));
  const judged = new Map(provesVerdicts(proves, report).map((verdict) => [verdict.requirement, verdict]));
  return requirements.map((requirement) => {
    const verdict = judged.get(requirement);
    return verdict ? { requirement, step: verdict.step, verdict: programCardLineVerdict(requirement, verdict.outcome, failed.has(requirement)) }
      : { requirement, verdict: "not_tested" };
  });
}

function changesOf(before     , after     , left     , right     , idea     , opts      = {}) {
  const diff      = compareLookReports(before, after);
  const gone = new Map                ();
  for (const problem of diff.fixed) gone.set(problem.code, (gone.get(problem.code) ?? 0) + 1);
  const added        = [], moved        = [];
  const unfit = opts.game === true ? new Set        (PROGRAM_CARD_GAME_UNFIT_LOOK_CODES) : null;
  for (const problem of diff.new) {

    if (unfit?.has(problem.code) || isRetiredLookProblem(problem)) continue;
    const pending = gone.get(problem.code) ?? 0;
    if (pending > 0) gone.set(problem.code, pending - 1);
    (pending > 0 ? moved : added).push(problem);
  }
  const problems = added.slice(0, REGRESSIONS_MAX).map(problemOf);

  const promises = (Array.isArray(idea?.changes) ? idea.changes : []).map((change     ) =>
    ({ step: change.step, shows: change.shows, outcome: promiseOf(before, after, change) }));
  const kept = new Set(promises.filter((promise     ) => promise.outcome === "kept").map((promise     ) => promise.step));
  const was = programCardTestVerdicts(opts.asks, opts.proves, before);
  const now = was ? programCardTestVerdicts(opts.asks, opts.proves, after, was) : null;
  const askSteps = new Set(Object.keys(was ? opts.proves : {}).map(Number));

  const lost = (now ?? []).flatMap((test     , i        ) => {
    const old = was [i];
    return MET.has(old.verdict) && (test.verdict === "still_open" || test.verdict === "not_tested")
      ? [{ requirement: test.requirement, step: test.step ?? old.step, before: old.verdict, after: test.verdict }] : [];
  });
  const asks = lost.filter((test     ) => !kept.has(test.step)).slice(0, REGRESSIONS_MAX);
  const changedAsks = lost.filter((test     ) => kept.has(test.step)).slice(0, REGRESSIONS_MAX);
  const passed = new Set(before.steps.filter((step     ) => step.expectOutcome === "passed").map((step     ) => step.index));
  const failed = new Set(before.steps.filter((step     ) => step.expectOutcome === "failed").map((step     ) => step.index));
  const expectOf = (step     ) => ({ step: step.index, ...(typeof step.expect === "string" ? { expect: step.expect.slice(0, 120) } : {}) });
  const broken = after.steps.filter((step     ) => step.expectOutcome === "failed" && passed.has(step.index) && !askSteps.has(step.index))
    .map(expectOf);
  const changed = broken.filter((step     ) => kept.has(step.step)).slice(0, REGRESSIONS_MAX);
  const failedExpects = broken.filter((step     ) => !kept.has(step.step)).slice(0, REGRESSIONS_MAX);
  const fixedExpects = after.steps.filter((step     ) => step.expectOutcome === "passed" && failed.has(step.index))
    .slice(0, REGRESSIONS_MAX).map(expectOf);
  const costWarning = after.ok !== false ? costOf(left, right) : null;
  const expects = asks.map((test     ) => ({ step: test.step, expect: test.requirement.slice(0, 120) }));
  return { ...(problems.length || asks.length ? { regressions: { problems, expects, ...(asks.length ? { asks } : {}) } } : {}),
    ...(moved.length ? { moved: moved.slice(0, REGRESSIONS_MAX).map(problemOf) } : {}),
    ...(promises.length ? { promises } : {}),
    ...(now ? { asks: { before: was .map(({ requirement, verdict }     ) => ({ requirement, verdict })),
      after: now.map(({ requirement, verdict }     ) => ({ requirement, verdict })) } } : {}),
    ...(changedAsks.length ? { changedAsks } : {}),
    ...(changed.length ? { changedExpects: changed } : {}),
    ...(failedExpects.length ? { failedExpects } : {}),
    ...(fixedExpects.length ? { fixedExpects } : {}),
    ...(costWarning ? { costWarning } : {}) };
}

function programCardCostNote(cost     )                {
  if (!cost || !Number.isFinite(cost.after) || !Number.isFinite(cost.before)) return null;
  const what = cost.metric === "batteryPerMinute" ? "battery" : "glasses time";
  if (!(cost.before > 0)) return `uses more ${what}`;
  return `uses ${(Math.round(cost.after / cost.before * 10) / 10).toFixed(1)}× the ${what}`;
}

function stepsCost(report     , cited             ) {
  const result = { g2ms: 0, updates: 0, elapsedMs: 0 };
  for (const step of report?.steps || []) {
    if (!cited.has(step.index)) continue;
    result.g2ms += Number(step.g2ms) || 0;
    result.updates += (Number(step.wakes) || 0) + (Number(step.rebuild) || 0) + (Number(step.texts) || 0) + (Number(step.tiles) || 0);
    result.elapsedMs += Number(step.elapsedMs) || 0;
  }
  return result;
}

const GAIN_SHARE = 0.01;
const EPSILON = 1e-9;

function judgeSteps(metric        , before     , after     , left     , right     , cited             ) {
  const was = stepsCost(before, cited), now = stepsCost(after, cited);
  if (metric === "g2ms") {
    if (was.g2ms > 0) return { scope: "steps", before: was.g2ms, after: now.g2ms,
      helped: now.g2ms <= was.g2ms * (1 - GAIN_SHARE) + EPSILON,
      kept: left.g2ms - right.g2ms + EPSILON >= was.g2ms * GAIN_SHARE };
  } else if (was.elapsedMs > 0 && now.elapsedMs > 0 && was.updates > 0) {
    const prior = was.updates * 60_000 / was.elapsedMs, current = now.updates * 60_000 / now.elapsedMs;
    const planUpdates = (summary     ) => summary.wakes + summary.rebuild + summary.texts + summary.tiles;
    return { scope: "steps", before: prior, after: current,
      helped: current <= prior * (1 - GAIN_SHARE) + EPSILON,
      kept: planUpdates(left) - planUpdates(right) + EPSILON >= was.updates * GAIN_SHARE };
  }
  return null;
}

function judgePlan(metric        , left     , right     ) {
  const prior = metric === "battery_per_minute" ? left.batteryPerMinute : left.g2ms;
  const current = metric === "battery_per_minute" ? right.batteryPerMinute : right.g2ms;
  if (prior === null || current === null) return null;
  return { scope: "plan", before: prior, after: current, helped: prior > 0 && current <= prior * (1 - GAIN_SHARE) + EPSILON, kept: true };
}

const share = (judged     ) => judged.before > 0 ? (judged.before - judged.after) / judged.before : -Infinity;

function judge(metric        , before     , after     , left     , right     , cited             ) {
  const steps = judgeSteps(metric, before, after, left, right, cited), plan = judgePlan(metric, left, right);
  if (steps?.helped && steps.kept) return steps;
  if (plan?.helped) return plan;
  if (steps?.helped) return steps;
  if (!steps || !plan) return steps || plan;
  return share(plan) > share(steps) ? plan : steps;
}

function compareProgramCardReviewLook(before     , rawAfter     , expectedDigest        , idea     , baseDigest         ,
  opts                                               = {})      {
  const left = summary(before);
  if (!left) return { ok: false, error: "invalid_look_metrics" };
  if (rawAfter === undefined) return { ok: true, compare: { status: "not_measured", reason: "look_missing", before: left, after: null } };
  const checked = validateLookReport(rawAfter);
  if (!checked.ok) return checked;
  const after = checked.report;
  if (after.pictures.length > 2) return { ok: false, error: "compare_pictures_limit" };
  if (after.digest !== expectedDigest) return { ok: false, error: "look_stale" };
  if (!before || before.planHash !== after.planHash || before.t0 !== after.t0 ||
    before.steps.length !== after.steps.length || before.steps.some((step     , index        ) =>
      step.index !== after.steps[index].index || step.do !== after.steps[index].do)) return { ok: false, error: "look_plan_changed" };
  const right = summary(after);
  if (!right) return { ok: false, error: "invalid_look_metrics" };
  const metric = idea.kind === "battery" ? "battery_per_minute" : "g2ms";
  if (baseDigest !== undefined && before.digest !== baseDigest) return { ok: true, compare: {
    status: "not_measured", reason: "baseline_stale", metric, before: null, after: right,
  } };
  const broke = before.ok !== false ? changesOf(before, after, left, right, idea, opts) : {};
  const known = new Set(before.steps.map((step     ) => step.index));

  const cited = Array.isArray(idea.steps) ? idea.steps : [];
  const measured = before.ok !== false && after.ok !== false && cited.every((step     ) => known.has(step));
  const judged = !measured ? null : cited.length ? judge(metric, before, after, left, right, new Set(cited)) : judgePlan(metric, left, right);
  const fewerRebuilds = right.rebuild < left.rebuild;
  if (!measured || (!judged && !fewerRebuilds)) return { ok: true, compare: {
    status: "not_measured", reason: before.ok === false || after.ok === false ? "look_failed" : !measured ? "steps_not_measured" : "no_wait_window",
    metric, before: left, after: right, ...broke,
  } };
  const prior = metric === "battery_per_minute" ? left.batteryPerMinute : left.g2ms;
  const current = metric === "battery_per_minute" ? right.batteryPerMinute : right.g2ms;
  const reduction = prior > 0 ? (prior - current) / prior : null;
  const moved = judged !== null && judged.helped && !judged.kept;
  return { ok: true, compare: { status: "measured", metric, before: left, after: right,
    gain: fewerRebuilds || (judged !== null && judged.helped && judged.kept), reduction,
    ...(judged ? { judged: { scope: judged.scope, before: judged.before, after: judged.after, needed: GAIN_SHARE } } : {}),
    ...(fewerRebuilds ? { reason: "fewer_rebuilds" } : moved ? { reason: "cost_moved" } : {}), ...broke,
  } };
}

function programCardAfterLookFailure(before     , after     , expectedDigest        )                {
  if (!before || before.ok === false || !after || typeof after !== "object" ||
    after.digest !== expectedDigest || after.error === "look_cancelled") return null;
  const screens = (report     )        => Array.isArray(report?.problems) ? report.problems.filter((problem     ) =>
    (problem?.code === "error_screen" || problem?.code === "card_error") &&
    typeof problem.message === "string" && problem.message.trim()) : [];
  const lineOf = (problem     ) => problem.message.split("\n")[0].slice(0, 200);
  const seen = new Set(screens(before).map(lineOf));

  const shown = after.ok === false ? screens(after)[0] : screens(after).find(problem => !seen.has(lineOf(problem)));
  const screen = shown
    ? `. The card showed an error${Number.isInteger(shown.step) ? ` at step ${shown.step + 1}` : ""}: ${lineOf(shown)}`
    : "";
  if (after.ok !== false) return screen ? `the behaviour check failed${screen}` : null;
  const code = typeof after.error === "string" && after.error ? after.error.slice(0, 80) : "look_failed";
  const index = Array.isArray(after.steps) ? after.steps.length : -1;
  const step = Array.isArray(after.plan) && index >= 0 ? after.plan[index] : undefined;
  const where = typeof step?.do === "string" ? ` at step ${index + 1} (${step.do.slice(0, 80)})` : "";
  const message = typeof after.message === "string" && after.message.trim() ? `: ${after.message.slice(0, 160)}` : "";
  return `the behaviour check failed${where} with ${code}${message}${screen}`;
}

module.exports = { PROGRAM_CARD_GAME_UNFIT_LOOK_CODES, programCardTestVerdicts, programCardCostNote, compareProgramCardReviewLook, programCardAfterLookFailure };
