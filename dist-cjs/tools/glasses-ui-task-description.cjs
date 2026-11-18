const TASK_SHORT_DESCRIPTION_MAX = 80;

const TASK_DESCRIPTION_LIMIT = 500;

const GLASSES_RULES_START = /^shown on even g2 glasses\b/i;

function oneLine(text        )         {
  return text.replace(/\s+/g, " ").trim();
}

function cutAtWord(text        , max        )         {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  const cut = (space >= Math.floor(max / 2) ? head.slice(0, space) : head).replace(/[\s,;:.\-–—]+$/, "");
  return `${cut}…`;
}

function taskRequestSummary(request         )         {
  if (typeof request !== "string") return "";
  const paragraphs = request.split(/\n\s*\n/);
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed || GLASSES_RULES_START.test(trimmed)) continue;
    const first = oneLine(trimmed.split("\n").find((line) => line.trim()) || "");
    if (first) return cutAtWord(first, TASK_SHORT_DESCRIPTION_MAX);
  }
  return "";
}

function taskShortDescription(input

  = {})         {
  const starter = typeof input.starterDescription === "string" ? oneLine(input.starterDescription) : "";
  if (starter && !GLASSES_RULES_START.test(starter)) return cutAtWord(starter, TASK_DESCRIPTION_LIMIT);
  const fromRequest = taskRequestSummary(input.request);
  if (fromRequest) return fromRequest;
  const when = typeof input.whenText === "string" ? oneLine(input.whenText) : "";
  if (!when) return "";
  return cutAtWord(when.charAt(0).toUpperCase() + when.slice(1), TASK_SHORT_DESCRIPTION_MAX);
}

module.exports = { TASK_SHORT_DESCRIPTION_MAX, taskRequestSummary, taskShortDescription };
