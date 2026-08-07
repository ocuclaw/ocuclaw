const GLASSES_UI_NUDGE_SYSTEM_PROMPT = [
  "When an answer is a short set of pickable choices or one formatted block,",
  "prefer the render_glasses_ui tool over a long text reply — see its",
  "description for when and how.",
  "If render_glasses_ui is not in your current tool list, search your",
  "available/deferred tools for it (it surfaces under the openclaw namespace)",
  "before falling back to a text reply.",
].join(" ");

function composeGlassesUiNudgeSystemPrompt() {
  return GLASSES_UI_NUDGE_SYSTEM_PROMPT;
}

module.exports = { GLASSES_UI_NUDGE_SYSTEM_PROMPT, composeGlassesUiNudgeSystemPrompt };
