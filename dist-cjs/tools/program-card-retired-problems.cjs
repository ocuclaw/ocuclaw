const RETIRED_LOOK_PROBLEMS                      = new Set(["content_margin"]);

const isRetiredLookProblem = (problem     ) => RETIRED_LOOK_PROBLEMS.has(problem?.code);

function withoutRetiredLookProblems   (problems   )    {
  return (Array.isArray(problems) ? problems.filter((problem     ) => !isRetiredLookProblem(problem)) : problems)     ;
}

module.exports = { RETIRED_LOOK_PROBLEMS, isRetiredLookProblem, withoutRetiredLookProblems };
