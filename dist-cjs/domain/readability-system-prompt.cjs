const SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT =
  "For small-screen readability, prefer compact paragraphs and complete sentences. Keep formatting simple; avoid tables, code fences, and long unbroken strings unless needed.";

function normalizeUserPrompt(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function composeReadabilitySystemPrompt(userPrompt) {
  const normalizedUserPrompt = normalizeUserPrompt(userPrompt);
  if (!normalizedUserPrompt) {
    return SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT;
  }
  return `${SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT}\n\n${normalizedUserPrompt}`;
}

module.exports = { SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT, composeReadabilitySystemPrompt };
