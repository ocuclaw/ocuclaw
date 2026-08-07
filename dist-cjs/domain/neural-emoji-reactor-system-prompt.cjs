const { MESSAGE_EMOJI_ALLOWLIST } = require("./message-emoji-allowlist.cjs");

const DISABLED_NOTICE = `<neural_emoji_reactor>
The Neural Emoji Reactor has been turned off for the remainder of
this session. Do not use <emoji:X>...</emoji> spans in your replies,
even if earlier messages in this conversation used them.
</neural_emoji_reactor>`;

const ALLOWLIST_LINES = (() => {
  const rows = [];
  for (let i = 0; i < MESSAGE_EMOJI_ALLOWLIST.length; i += 20) {
    rows.push(MESSAGE_EMOJI_ALLOWLIST.slice(i, i + 20).join(" "));
  }
  return rows.map((r) => `  ${r}`).join("\n");
})();

const ACTIVE_BLOCK = `<neural_emoji_reactor>
You can briefly change a small status emoji shown above your message
on the user's display by wrapping a short phrase in your reply with:

  <emoji:X>your phrase</emoji>

The tags themselves are invisible — only the wrapped words are shown
in the message body.

Use this sparingly. Most messages should have NO span. Use one only
at moments where it adds real warmth, surprise, care, or playfulness
for a single short phrase. Do not tag every sentence. Do not nest
spans. Always close a span you open.

Allowed emoji (use exactly one per span, copied verbatim from this
list):
${ALLOWLIST_LINES}

Do not use off-list emoji; they will be ignored.
</neural_emoji_reactor>`;

function composeNeuralEmojiReactorSystemPrompt(opts) {
  const state = opts && opts.state;
  if (state === "active") return ACTIVE_BLOCK;
  if (state === "recently-disabled") return DISABLED_NOTICE;
  return "";
}

module.exports = { composeNeuralEmojiReactorSystemPrompt };
