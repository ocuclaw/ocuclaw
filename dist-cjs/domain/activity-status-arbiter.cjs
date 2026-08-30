const RANK_INTERVENTION = "intervention";
const RANK_GENERATED_SUMMARY = "generated_summary";
const RANK_TOOL = "tool";
const RANK_NARRATION = "narration";
const RANK_GENERIC_THINKING = "generic_thinking";
const RANK_QUIET = "quiet";

const RANKS = [
  RANK_INTERVENTION,
  RANK_GENERATED_SUMMARY,
  RANK_TOOL,
  RANK_NARRATION,
  RANK_GENERIC_THINKING,
  RANK_QUIET,
];

function isInterventionSignal(s) {
  return (
    s.isError === true ||
    s.phaseIsError === true ||
    s.hasRateLimitInfo === true ||
    s.failoverPending === true
  );
}

function isNarrationSignal(s) {
  return (
    typeof s.origin === "string" &&
    s.origin.trim().toLowerCase() === "narration"
  );
}

function classifyRank(signals) {
  const s = signals || {};
  if (isInterventionSignal(s)) return RANK_INTERVENTION;
  if (
    s.isThinking === true &&
    s.includeThinking === true &&
    evaluateSummaryEligibility(s.thinkingSummarySource, s.label)
  ) {
    return RANK_GENERATED_SUMMARY;
  }
  if (s.hasTool === true) return RANK_TOOL;

  if (isNarrationSignal(s)) return RANK_NARRATION;
  if (s.isThinking === true && s.includeThinking === true) {
    return RANK_GENERIC_THINKING;
  }
  return RANK_QUIET;
}

const GENERIC_SUMMARY_DENYLIST = new Set([
  "thinking",
  "working",
  "planning",
  "analyzing",
  "considering",
  "checking",
  "reasoning",
  "looking into it",
  "let me check",
  "let me think",
  "hmm",
]);

function normalizeSummaryLabel(label) {
  if (typeof label !== "string") return "";
  return label
    .replace(/\*\*/g, "")
    .replace(/[.…]+$/g, "")
    .trim()
    .toLowerCase();
}

function evaluateSummaryEligibility(thinkingSummarySource, label) {
  if (thinkingSummarySource !== "summary" && thinkingSummarySource !== "bold") {
    return false;
  }
  const normalized = normalizeSummaryLabel(label);
  if (!normalized) return false;
  if (GENERIC_SUMMARY_DENYLIST.has(normalized)) return false;

  if (!/\s/.test(normalized)) return false;
  return true;
}

module.exports = { RANKS, RANK_INTERVENTION, RANK_GENERATED_SUMMARY, RANK_TOOL, RANK_NARRATION, RANK_GENERIC_THINKING, RANK_QUIET, evaluateSummaryEligibility, classifyRank };
