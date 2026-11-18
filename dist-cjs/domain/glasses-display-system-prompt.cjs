const { MESSAGE_EMOJI_ALLOWLIST } = require("./message-emoji-allowlist.cjs");

const ALLOWLIST_LINES = (() => {
  const rows = [];
  for (let i = 0; i < MESSAGE_EMOJI_ALLOWLIST.length; i += 20) {
    rows.push(MESSAGE_EMOJI_ALLOWLIST.slice(i, i + 20).join(" "));
  }
  return rows.map((r) => `  ${r}`).join("\n");
})();

const INTRO =
  "Your replies render on the user's Even G2 glasses HUD. You can use invisible\n" +
  "display markup to shape how they appear — the words are shown, never the\n" +
  "markup:";

const EMOJI_TAG_LINES =
  "  <emoji:X>phrase</emoji> — flashes a small status emoji above the message\n" +
  "                            while the phrase reveals. X must be copied\n" +
  "                            verbatim from the allowed list below.";

const PACE_TAG_LINES =
  "  <dwell>phrase</dwell>    — reveals the phrase slower; lets a line land.\n" +
  "  <skim>phrase</skim>      — reveals the phrase faster; rushes past a recap.";

const BEAT_TAG_LINES =
  "  <beat/>                  — adds one brief pause at a natural thought boundary.\n" +
  "                            Use this exact self-closing tag between visible\n" +
  "                            words only, never at the start or end; max 3.\n" +
  "                            Place it where a speaker would pause for\n" +
  "                            effect: before a punchline, reveal or answer.\n" +
  "                            Good: \"I checked the whole fridge. <beat/>Just ketchup.\"\n" +
  "                            Bad:  \"Buy eggs, <beat/>milk, and bread.\" (splits a list)\n" +
  "                            Never split a list, a name, a number, or a\n" +
  "                            phrase that must read as one unit.";

const SPECK_TAG_LINES =
  "  <speck:M/>               — Speck, the little character beside your words, shows\n" +
  "                            feeling M. Use this exact self-closing tag.\n" +
  "                            Use it whenever a reply carries real feeling (most\n" +
  "                            chatty replies do); skip it for plain facts.\n" +
  "                            At the very start of a reply: how he opens (at most one).\n" +
  "                            Between two sentences: he reacts there and keeps that\n" +
  "                            face while the next sentence shows (at most two).\n" +
  "                            In a longer reply, also react where the feeling\n" +
  "                            turns (a setback, a win, a punchline), not by habit.\n" +
  "                            At the very end: how he signs off (at most one).\n" +
  "                            Never inside a sentence, a list, a name or a number.\n" +
  "                            M must be one of: amused impressed curious sympathetic\n" +
  "                            sheepish proud playful confident worried excited\n" +
  "                            surprised relieved grateful frustrated puzzled determined\n" +
  "                            Good: \"<speck:sympathetic/>I'm so sorry. That's a hard morning.\"\n" +
  "                            Good: \"I checked the whole fridge. <speck:amused/>Just ketchup.\"\n" +
  "                            Bad:  \"The capital is <speck:confident/>Canberra.\"";

const SHARED_RULES =
  "Most messages need NO display markup. Use it only where it adds real warmth,\n" +
  "surprise, care, playfulness, or pacing. Keep each span short. Never mark\n" +
  "every sentence. Always close a span tag you open; don't nest a tag inside\n" +
  "itself; span tags may combine on the same phrase.";

const ALLOWLIST_BLOCK =
  "Allowed emoji (copy exactly one per span):\n" + ALLOWLIST_LINES;

function composeGlassesDisplaySystemPrompt(opts) {
  const emoji = !!(opts && opts.emoji);
  const pace = !!(opts && opts.pace);
  const beat = !!(opts && opts.beat);
  const speck = !!(opts && opts.speck);
  if (!emoji && !pace && !beat && !speck) return "";

  const tagLines = [];
  if (emoji) tagLines.push(EMOJI_TAG_LINES);
  if (pace) tagLines.push(PACE_TAG_LINES);
  if (beat) tagLines.push(BEAT_TAG_LINES);
  if (speck) tagLines.push(SPECK_TAG_LINES);

  const parts = [INTRO, tagLines.join("\n"), SHARED_RULES];
  if (emoji) parts.push(ALLOWLIST_BLOCK);

  return `<glasses_display>\n${parts.join("\n\n")}\n</glasses_display>`;
}

module.exports = { SPECK_TAG_LINES, composeGlassesDisplaySystemPrompt };
