const QUESTION_LIKELY_ANSWERS_OPENCLAW =
  "When you need the wearer to choose before you go on, ask with ask_user " +
  "rather than in chat, so the glasses show a card they can tap. Give it 2 " +
  "to 4 short likely answers as options, your best guess first; they can " +
  "still say or type their own.";

const QUESTION_LIKELY_ANSWERS_HERMES =
  "When you need the wearer to choose before you go on, ask with clarify " +
  "rather than in chat, so the glasses show a card they can tap. Give it 2 " +
  "to 4 short likely answers as choices, your best guess first; they can " +
  "still say or type their own.";

function composeQuestionLikelyAnswersChannelOne(host                       ) {
  return host === "hermes" ? QUESTION_LIKELY_ANSWERS_HERMES : QUESTION_LIKELY_ANSWERS_OPENCLAW;
}

module.exports = { QUESTION_LIKELY_ANSWERS_OPENCLAW, QUESTION_LIKELY_ANSWERS_HERMES, composeQuestionLikelyAnswersChannelOne };
