const { programCardUiCalls } = require("./program-card-kit-check.cjs");

const TASK_CARD_STATES                    = Object.freeze(["waiting", "ok", "unchecked", "empty"]);

const TASK_CARD_CASES                    = Object.freeze([
  "empty: every list is [] and every text is \"\"",
  "full: every list at its most rows, and more the host left out (+N more)",
  "long_text: every text at its longest, in wide letters",
  "cjk_text: every text at its longest, in Japanese",
  "number_as_text: numbers sent as words (\"1,204\", \" 7 \")",
  "missing_field: a list row without one of its fields",
  "unchecked_each: one value at a time the run couldn't check (null)",
  "unchecked_all: every value null",
  "old_26h: the values are 26 h old",
  "clock_2359: the clock reads 23:59",
  "monday_0001: the clock reads Monday 00:01",
  "five_runs: five runs in a row with no reset",
]);

function withoutComments(source        )         {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 1;
      out += " ";
    } else if (ch === "\"" || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
    } else {
      out += ch;
    }
  }
  return out;
}

function taskCardStatesNamed(source        )           {
  if (typeof source !== "string" || !source) return [];
  const text = withoutComments(source);
  return TASK_CARD_STATES.filter(name =>
    new RegExp(`(?<![\\w$.])${name}\\s*:|(["'\`])${name}\\1`).test(text));
}

function programCardTaskStatesRefusal(source        )                {
  if (typeof source !== "string" || !source.trim()) return null;
  const calls = new Set(programCardUiCalls(source));
  const named = new Set(taskCardStatesNamed(source));
  const missing = TASK_CARD_STATES.filter(name => !named.has(name));
  const problems           = [];
  if (!calls.has("taskState")) problems.push("its view never calls ui.taskState(values), which names the view to draw");
  if (missing.length) problems.push(`it has no ${missing.join(", ")} view`);
  if (!calls.has("unchecked")) problems.push("it never draws ui.unchecked(ctx.task?.unchecked?.[key]), the couldn't-check row");
  if (!problems.length) return null;
  return `task_states_missing: this Task card must draw every state, and ${problems.join("; ")}. ` +
    "Fix it from the taskGuide skeleton: body from { waiting, unchecked, empty, ok }[ui.taskState(state.values)], " +
    "and ui.unchecked(ctx.task?.unchecked?.[key]) ?? row where each value goes. Nothing was sent to the phone.";
}

module.exports = { TASK_CARD_STATES, TASK_CARD_CASES, taskCardStatesNamed, programCardTaskStatesRefusal };
