const { MESSAGE_EMOJI_ALLOWLIST } = require("./message-emoji-allowlist.cjs");

const ALLOWLIST_LINES = (() => {
  const rows = [];
  for (let i = 0; i < MESSAGE_EMOJI_ALLOWLIST.length; i += 20) {
    rows.push(MESSAGE_EMOJI_ALLOWLIST.slice(i, i + 20).join(" "));
  }
  return rows.map((r) => `  ${r}`).join("\n");
})();

const INTRO =
  "Your replies render on the user's Even G2 glasses HUD. You can wrap short\n" +
  "phrases with invisible tags that shape how they display — only the wrapped\n" +
  "words are shown, never the tags:";

const EMOJI_TAG_LINES =
  "  <emoji:X>phrase</emoji> — flashes a small status emoji above the message\n" +
  "                            while the phrase reveals. X must be copied\n" +
  "                            verbatim from the allowed list below.";

const PACE_TAG_LINES =
  "  <dwell>phrase</dwell>    — reveals the phrase slower; lets a line land.\n" +
  "  <skim>phrase</skim>      — reveals the phrase faster; rushes past a recap.";

const SHARED_RULES =
  "Most messages need NO tags. Use one only where it adds real warmth, surprise,\n" +
  "care, playfulness, or pacing for a single short phrase. Never tag every\n" +
  "sentence. Always close a tag you open; don't nest a tag inside itself; tags\n" +
  "may combine on the same phrase.";

const ALLOWLIST_BLOCK =
  "Allowed emoji (copy exactly one per span):\n" + ALLOWLIST_LINES;

function composeGlassesDisplaySystemPrompt(opts) {
  const emoji = !!(opts && opts.emoji);
  const pace = !!(opts && opts.pace);
  if (!emoji && !pace) return "";

  const tagLines = [];
  if (emoji) tagLines.push(EMOJI_TAG_LINES);
  if (pace) tagLines.push(PACE_TAG_LINES);

  const parts = [INTRO, tagLines.join("\n"), SHARED_RULES];
  if (emoji) parts.push(ALLOWLIST_BLOCK);

  return `<glasses_display>\n${parts.join("\n\n")}\n</glasses_display>`;
}

module.exports = { composeGlassesDisplaySystemPrompt };
