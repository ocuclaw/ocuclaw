const ACTIVITY_LAB_TOKENS = Object.freeze([
  "prose",
  "purpose",
  "headline",
  "counter",
  "no-custom",
  "reasoning-offer",
  "narrate",
  "bar-fits",
  "chapters",
]);

const ACTIVITY_LAB_DEFAULTS = Object.freeze([
  "chapters",
  "counter",
  "narrate",
  "no-custom",
  "prose",
  "purpose",
  "reasoning-offer",
]);

const ACTIVITY_LAB_HERMES_DEFAULTS = Object.freeze(["headline"]);

const ACTIVITY_LAB_CLAUDE_CODE_ENGINE = "claude-cli";
const ACTIVITY_LAB_CLAUDE_CODE_DEFAULTS = Object.freeze(["headline"]);

const ACTIVITY_LAB_LOCKED = Object.freeze(["chapters", "no-custom"]);

function narrateGuidanceWith(sentenceLength        ) {
  return (
    "While you work, the user watches your progress on their glasses. Think of\n" +
    "the job as a few parts. When you start a new part, first write a heading of\n" +
    "two to five words in bold on its own line, like **Checking the system**.\n" +
    `Then, before each tool call, write one short plain sentence ${sentenceLength}\n` +
    "saying what that call is about to do, like \"Reading the kernel version.\"\n" +
    "Start with the action itself, never with \"I'm\", \"I'll\" or \"Let me\". One\n" +
    "heading per part, not per call: calls that serve the same part share its\n" +
    "heading. One sentence per call, naming the file or thing itself rather than\n" +
    "\"it\". Skip all of this when you call no tools, and never repeat these\n" +
    "headings or sentences in your final reply."
  );
}

const ACTIVITY_NARRATE_GUIDANCE = narrateGuidanceWith("(ten words or fewer)");

const ACTIVITY_NARRATE_SHORT_GUIDANCE = narrateGuidanceWith("(40 characters or\nfewer, about six words)");

function activityNarrateGuidance(labs                   , notesInConversation         ) {
  return labs.includes("bar-fits") && !notesInConversation
    ? ACTIVITY_NARRATE_SHORT_GUIDANCE
    : ACTIVITY_NARRATE_GUIDANCE;
}

function normalizeActivityLabChoices(value         ) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const choices = new Map                 ();
  for (const entry of raw) {
    const text = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    const off = text.startsWith("-");
    const token = off ? text.slice(1).trim() : text;
    if (ACTIVITY_LAB_TOKENS.includes(token)) choices.set(token, !off);
  }
  return [...choices.keys()].sort().map((token) => (choices.get(token) ? token : `-${token}`));
}

function normalizeActivityLabs(value         ) {
  return normalizeActivityLabChoices(value).filter((choice) => !choice.startsWith("-"));
}

function activityLabChoicesEqual(a         , b         ) {
  return normalizeActivityLabChoices(a).join(",") === normalizeActivityLabChoices(b).join(",");
}

function activityLabDefaults(host          , engine          ) {
  const on = new Set        (ACTIVITY_LAB_DEFAULTS);
  if (host === "hermes") for (const token of ACTIVITY_LAB_HERMES_DEFAULTS) on.add(token);
  if (engine === ACTIVITY_LAB_CLAUDE_CODE_ENGINE) for (const token of ACTIVITY_LAB_CLAUDE_CODE_DEFAULTS) on.add(token);
  return [...on].sort();
}

function resolveActivityLabs(stored         , env         , host          , engine          ) {
  const on = new Set        (activityLabDefaults(host, engine));
  for (const layer of [stored, env]) {
    for (const choice of normalizeActivityLabChoices(layer)) {
      if (choice.startsWith("-")) on.delete(choice.slice(1));
      else on.add(choice);
    }
  }
  for (const token of ACTIVITY_LAB_LOCKED) on.add(token);
  return [...on].sort();
}

module.exports = { ACTIVITY_LAB_CLAUDE_CODE_DEFAULTS, ACTIVITY_LAB_CLAUDE_CODE_ENGINE, ACTIVITY_LAB_DEFAULTS, ACTIVITY_LAB_HERMES_DEFAULTS, ACTIVITY_LAB_LOCKED, ACTIVITY_LAB_TOKENS, ACTIVITY_NARRATE_GUIDANCE, ACTIVITY_NARRATE_SHORT_GUIDANCE, activityLabDefaults, activityLabChoicesEqual, activityNarrateGuidance, normalizeActivityLabChoices, normalizeActivityLabs, resolveActivityLabs };
