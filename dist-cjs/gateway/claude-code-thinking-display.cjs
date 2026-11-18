const CLAUDE_CODE_ENGINE = "claude-cli";
const EXTRA_BODY_ENV = "CLAUDE_CODE_EXTRA_BODY";
const SUMMARIZED_THINKING_BODY = JSON.stringify({ thinking: { type: "adaptive", display: "summarized" } });

const ADAPTIVE_THINKING_MODEL = /(?:^|[-/])claude-(?:[a-z]+-5|opus-4-[678]|sonnet-4-6|mythos-preview)(?=$|[^a-z0-9])/;

function takesAdaptiveThinking(modelId         ) {
  return typeof modelId === "string" && ADAPTIVE_THINKING_MODEL.test(modelId.trim().toLowerCase());
}

function createClaudeCodeThinkingDisplay(env         ) {

  const ownerSet = typeof env[EXTRA_BODY_ENV] === "string" && env[EXTRA_BODY_ENV] !== SUMMARIZED_THINKING_BODY;
  return function applyForRun(ctx     ) {
    if (ownerSet || !ctx) return;
    const provider = typeof ctx.modelProviderId === "string" ? ctx.modelProviderId : "";
    if (!provider) return;
    if (provider === CLAUDE_CODE_ENGINE && takesAdaptiveThinking(ctx.modelId)) {
      env[EXTRA_BODY_ENV] = SUMMARIZED_THINKING_BODY;
    } else if (env[EXTRA_BODY_ENV] === SUMMARIZED_THINKING_BODY) {
      delete env[EXTRA_BODY_ENV];
    }
  };
}

module.exports = { SUMMARIZED_THINKING_BODY, createClaudeCodeThinkingDisplay, takesAdaptiveThinking };
