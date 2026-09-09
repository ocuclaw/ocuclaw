const SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT =
  "For small-screen readability, prefer compact paragraphs and complete sentences. Keep formatting simple; avoid tables, code fences, and long unbroken strings unless needed.";

function normalizeUserPrompt(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function composeReadabilitySystemPrompt(
  userPrompt,
  { hostProvidesReadability = false } = {},
) {
  const normalizedUserPrompt = normalizeUserPrompt(userPrompt);
  if (hostProvidesReadability) {
    return normalizedUserPrompt;
  }
  if (!normalizedUserPrompt) {
    return SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT;
  }
  return `${SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT}\n\n${normalizedUserPrompt}`;
}

function splitReadabilitySystemPrompt(content) {
  const normalized = normalizeUserPrompt(content);
  const base = SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT;
  if (!normalized) return { readability: "" };
  if (normalized === base) return { readability: base };
  if (normalized.startsWith(`${base}\n\n`)) return { readability: base };
  return { readability: "" };
}

module.exports = { SMALL_SCREEN_READABILITY_BASE_SYSTEM_PROMPT, composeReadabilitySystemPrompt, splitReadabilitySystemPrompt };
