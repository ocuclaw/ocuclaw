const { isRetiredLookProblem } = require("./program-card-retired-problems.cjs");

const PROGRAM_CARD_OPEN_FINDINGS_MAX = 12;
const MESSAGE_MAX = 200;

const record = (value     ) => !!value && typeof value === "object" && !Array.isArray(value);

function sortedJson(value     )         {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

const actionOf = (step     ) => [step?.do ?? null, step?.times === 1 ? null : step?.times ?? null, step?.every ?? null,
  step?.watch ?? null, step?.control ?? null, step?.fresh === true];

function placeOf(start     , plan       , count        ) {
  return sortedJson([start ?? null, plan.slice(0, count).map(actionOf)]);
}

function firstStep(problem     )                {
  if (Number.isInteger(problem?.step)) return problem.step;
  const steps = Array.isArray(problem?.steps) ? problem.steps.filter((step     ) => Number.isInteger(step)) : [];
  return steps.length ? Math.min(...steps) : null;
}

function programCardFindingKey(problem     ) {
  return JSON.stringify([problem?.code ?? null, problem?.path ?? null, problem?.id ?? null]);
}

function noteProgramCardTestFindings(open                  , report     , plan     , start      ) {
  const steps        = Array.isArray(plan) ? plan : [];
  const reported               = Array.isArray(report?.steps) ? report.steps : null;
  const ran = reported ? Math.min(steps.length, reported.length) : steps.length;
  const skippedAt = reported ? reported.slice(0, ran).findIndex((step     ) => !!step?.skipped) : -1;
  const followed = skippedAt >= 0 ? skippedAt : ran;
  const seen = new Set        ();
  for (let count = 0; count <= followed; count++) seen.add(placeOf(start, steps, count));
  for (const [key, finding] of open) if (seen.has(finding.place)) open.delete(key);
  for (const problem of Array.isArray(report?.problems) ? report.problems : []) {
    if (!record(problem) || typeof problem.code !== "string" || !problem.code || isRetiredLookProblem(problem)) continue;
    const at = firstStep(problem);

    const count = at !== null && at >= 0 && at < ran ? at + 1 : ran;
    const key = programCardFindingKey(problem);
    open.delete(key);
    open.set(key, {
      code: problem.code,
      message: typeof problem.message === "string" ? problem.message.slice(0, MESSAGE_MAX) : "",
      ...(typeof problem.severity === "string" ? { severity: problem.severity } : {}),
      ...(typeof problem.surface === "string" ? { surface: problem.surface } : {}),
      ...(at !== null ? { step: at } : {}),
      place: placeOf(start, steps, count),
    });
  }
  while (open.size > PROGRAM_CARD_OPEN_FINDINGS_MAX) open.delete(open.keys().next().value          );
  return open;
}

function programCardOpenFindingRows(open                                     ) {
  return open ? Array.from(open.values(), ({ place: _place, ...finding }) => ({ ...finding })) : [];
}

module.exports = { PROGRAM_CARD_OPEN_FINDINGS_MAX, programCardFindingKey, noteProgramCardTestFindings, programCardOpenFindingRows };
