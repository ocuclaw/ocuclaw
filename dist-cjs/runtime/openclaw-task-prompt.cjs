const { TASK_FIT_PROMPT, TASK_UNCHECKED_PROMPT } = require("../tools/glasses-ui-task-unchecked.cjs");
const { GLASSES_PROMPT_RULES, GLASSES_URGENT_PROMPT_RULES, HERMES_SILENT_TOKEN, OPENCLAW_SILENT_TOKEN, startsWithHostGlassesRules } = require("../tools/glasses-ui-task-rules.cjs");

function asksNothingUrgent(request        , look      = null) {
  if (String(request).trim().startsWith(GLASSES_URGENT_PROMPT_RULES)) return true;
  const inputs = look && typeof look === "object" && Array.isArray(look.inputs) ? look.inputs : [];
  return inputs.some((entry     ) => entry && typeof entry === "object" && entry.key === "urgent");
}

const SCALAR_WORDS      = { number: "a number", text: "text", bool: "true or false", image: "a picture link" };

function pythonG(value        ) {
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const [mantissa, rawExp] = value.toExponential(5).split("e");
  const exp = Number(rawExp);
  const strip = (digits        ) => (digits.includes(".") ? digits.replace(/0+$/, "").replace(/\.$/, "") : digits);
  if (exp < -4 || exp >= 6) {
    const sign = exp < 0 ? "-" : "+";
    return `${strip(mantissa)}e${sign}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  return strip(value.toFixed(Math.max(0, 5 - exp)));
}

function inputWords(entry     ) {
  const kind = entry.type;
  if (kind === "list") {
    const most = entry.maxItems === undefined ? 20 : entry.maxItems;
    const fields = entry.fields && typeof entry.fields === "object" ? entry.fields : null;
    if (fields && Object.keys(fields).length > 0) {
      const row = Object.entries(fields).map(([name, field]     ) => `${name} (${SCALAR_WORDS[field]})`).join(", ");
      return `a list of at most ${most} rows, each an object with ${row}`;
    }
    return `a list of at most ${most} items, each ${SCALAR_WORDS[entry.of || "text"]}`;
  }
  let words = SCALAR_WORDS[kind];
  if (kind === "text" && entry.maxBytes !== undefined) words += `, at most ${entry.maxBytes} bytes`;
  if (kind === "number") {
    const low = entry.min === undefined || entry.min === null ? null : entry.min;
    const high = entry.max === undefined || entry.max === null ? null : entry.max;
    if (low !== null && high !== null) words += ` from ${pythonG(low)} to ${pythonG(high)}`;
    else if (low !== null) words += `, at least ${pythonG(low)}`;
    else if (high !== null) words += `, at most ${pythonG(high)}`;
  }
  return words;
}

function lookPrompt(look     ) {
  const lines = [`This Task's card is "${String(look.name).trim()}". In the ocuclaw-card block, ` +
    "give one JSON object with exactly these keys:"];
  for (const entry of look.inputs) {
    const label = String(entry.label || "").trim();
    const named = label && label !== entry.key ? `${entry.key} (${label})` : entry.key;
    lines.push(`- ${named}: ${inputWords(entry)}`);
  }

  lines.push(TASK_FIT_PROMPT);

  lines.push(TASK_UNCHECKED_PROMPT);
  return lines.join("\n");
}

const OPENCLAW_RUN_NOTE =
  "This runs on a schedule. Answer in text only and do not call any glasses tool; " +
  "OcuClaw shows your answer on the glasses.";

function requestWithoutGlassesRules(request        ) {
  const text = String(request).trim();

  for (const rules of [GLASSES_URGENT_PROMPT_RULES, GLASSES_PROMPT_RULES]) {
    if (text.startsWith(rules)) return text.slice(rules.length).trim();
  }
  return text;
}

function rulesFor(request        , look      = null) {
  return asksNothingUrgent(request, look) ? GLASSES_URGENT_PROMPT_RULES : GLASSES_PROMPT_RULES;
}

function taskRunPrompt(request        , look      = null) {
  const card = look ? `${lookPrompt(look)}\n\n` : "";
  return `${rulesFor(request, look)}\n\n${OPENCLAW_RUN_NOTE}\n\n${card}${requestWithoutGlassesRules(request)}`;
}

function openCardPrompt() {
  return [
    "This Task's card is still to be built. In the ocuclaw-card block, give one JSON object with " +
      "the values this run found, 1 to 8 keys, each one thing a glanceable card would show.",
    "Name each key in lowercase English letters, digits and _ (at most 32), starting with a letter, " +
      "and keep the same names every run.",
    "Give each value in its own type: numbers as numbers, yes/no as true or false, lists as lists, " +
      "a list's rows as objects with the same keys. Put a list's most important rows first.",
    "Never give a value as one object: give each of its parts its own key " +
      "(next_meeting_title and next_meeting_time, not next_meeting with both inside).",
    TASK_UNCHECKED_PROMPT,
  ].join("\n");
}

function openCardTaskRunPrompt(request        ) {
  return `${rulesFor(request)}\n\n${OPENCLAW_RUN_NOTE}\n\n${openCardPrompt()}\n\n${requestWithoutGlassesRules(request)}`;
}

module.exports = { GLASSES_PROMPT_RULES, GLASSES_URGENT_PROMPT_RULES, HERMES_SILENT_TOKEN, OPENCLAW_SILENT_TOKEN, startsWithHostGlassesRules, asksNothingUrgent, pythonG, lookPrompt, OPENCLAW_RUN_NOTE, requestWithoutGlassesRules, taskRunPrompt, openCardPrompt, openCardTaskRunPrompt };
