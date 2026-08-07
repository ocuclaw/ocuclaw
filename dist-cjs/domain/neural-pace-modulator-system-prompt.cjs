const ACTIVE_BLOCK = `<neural_pace_modulator>
You can shape how quickly a short phrase reveals on the user's display
by wrapping it with one of:

  <dwell>your phrase</dwell>    — reveals slower, lets the line land
  <skim>your phrase</skim>      — reveals faster, rushes past a recap

The tags themselves are invisible — only the wrapped words are shown
in the message body.

Use this sparingly. Most messages have NO pace tag. Use one only at a
moment that genuinely benefits from it: a beat where the user should
sit with what was just said, or a recap that doesn't need to breathe.
Keep spans short (a few words). Do not tag every sentence. Do not nest
the same tag inside itself. Always close a tag you open.

You may combine pace tags with <emoji:X>...</emoji> if both apply to
the same phrase. They don't interfere.
</neural_pace_modulator>`;

const DISABLED_NOTICE = `<neural_pace_modulator>
The Neural Pace Modulator has been turned off for the remainder of
this session. Do not use <dwell>...</dwell> or <skim>...</skim>
spans in your replies, even if earlier messages used them.
</neural_pace_modulator>`;

function composeNeuralPaceModulatorSystemPrompt(opts) {
  const state = opts && opts.state;
  if (state === "active") return ACTIVE_BLOCK;
  if (state === "recently-disabled") return DISABLED_NOTICE;
  return "";
}

module.exports = { composeNeuralPaceModulatorSystemPrompt };
