const OPENCLAW_SILENT_TOKEN = "NO_REPLY";

const HERMES_SILENT_TOKEN = "[SILENT]";

const RULES_HEAD =
  "Shown on Even G2 glasses, about 50 characters a line. Plain text only: " +
  "no markdown, links, tables, greetings or emoji. Start with one headline " +
  "line under 50 characters that sums up the whole result, even when a skill " +
  "or the task sets its own format. Then at most 6 short lines in time order, most " +
  "important first. ";
const NOTHING_URGENT_RULE = "Say \"Nothing urgent\" rather than leave it out. ";
const RULES_TAIL =
  `If nothing is worth showing, respond with ${OPENCLAW_SILENT_TOKEN}. After the text, add ` +
  "one fenced ocuclaw-card block with the card's JSON values.";

const GLASSES_PROMPT_RULES = RULES_HEAD + RULES_TAIL;
const GLASSES_URGENT_PROMPT_RULES = RULES_HEAD + NOTHING_URGENT_RULE + RULES_TAIL;

function startsWithHostGlassesRules(request         , host        ) {
  if (typeof request !== "string") return false;
  const text = request.trim();
  const own = (rules        ) => (host === "hermes" ? rules.replace(OPENCLAW_SILENT_TOKEN, HERMES_SILENT_TOKEN) : rules);
  return [GLASSES_URGENT_PROMPT_RULES, GLASSES_PROMPT_RULES].some((rules) => text.startsWith(own(rules)));
}

module.exports = { OPENCLAW_SILENT_TOKEN, HERMES_SILENT_TOKEN, GLASSES_PROMPT_RULES, GLASSES_URGENT_PROMPT_RULES, startsWithHostGlassesRules };
