const CUSTOM_SYSTEM_PROMPT_MAX_CODE_POINTS = 4_000;

function normalizeCustomSystemPrompt(value) {
  return typeof value === "string" ? value.trim() : "";
}

function countUnicodeCodePoints(value) {
  return Array.from(typeof value === "string" ? value : "").length;
}

function normalizeAndValidateCustomSystemPrompt(value) {
  const normalized = normalizeCustomSystemPrompt(value);
  const codePointCount = countUnicodeCodePoints(normalized);
  if (codePointCount > CUSTOM_SYSTEM_PROMPT_MAX_CODE_POINTS) {
    throw new RangeError(
      `systemPrompt must be 4,000 Unicode code points or fewer after trimming ` +
        `(received ${codePointCount.toLocaleString("en-US")}). Shorten it before saving.`,
    );
  }
  return normalized;
}

module.exports = { CUSTOM_SYSTEM_PROMPT_MAX_CODE_POINTS, normalizeCustomSystemPrompt, countUnicodeCodePoints, normalizeAndValidateCustomSystemPrompt };
