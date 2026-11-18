const { createHash } = require("node:crypto");
const { JEV_QUESTIONS, SURFACE_DECISION_SCOPE } = require("./glasses-ui-surface-decision.cjs");

const CARD_FLOOR = 0.6;

const CARD_SHAPE = "program_card";

const PROGRAM_CARD_CRITERIA = {
  what: "Build them a small program on the glasses that they work themselves with taps: it keeps its own state or runs its own logic. A timer with rounds or phases, a game, a calculator or converter with inputs they adjust, a quiz or flashcards that reveal and keep score, a scorekeeper or counter with undo, or a custom drawing that moves or steps.",
  not_for:
    "Something they only read, pick from once, tick off or glance at; one plain timer or countdown; one computed answer; an explanation of how a game, a workout or a tool works; choosing one value from a range (a duration, a number) to start something; a tally or log they fill in by saying the counts out loud",
  examples: [
    "make me an interval timer, 6 rounds of 40 on and 20 off",
    "let's play hangman",
    "a currency converter I can nudge up and down",
    "count my laps of the pool as I tap, with an undo",
  ],
};

const PROGRAM_CARD_QUESTION = {
  type: "choice",
  instructions: {
    question:
      "Should the assistant build the wearer a small program on the glasses for this, rather than answer it in chat or show the answer on the glasses?",
    focus: "Judge by whether the wearer will work it themselves with taps, again and again, not by how useful a program would be.",
    inspect: "wearer_said",
  },
  criteria: {
    program_card: PROGRAM_CARD_CRITERIA,
    answer: {
      what: "Answer it: in chat, or by showing the answer on the glasses to read, pick from, tick off, glance at or watch.",
      not_for:
        "A timer with rounds or phases, a game, a calculator with inputs they adjust, a quiz that keeps score, a scorekeeper with undo",
      examples: ["which of these three should I take", "twenty-five minutes head-down, starting now", "why do cats knead?"],
    },
  },
};

const JEV_CARD_QUESTIONS = { ...JEV_QUESTIONS, program_card: PROGRAM_CARD_QUESTION };

const CARD_QUESTION_DIGEST = `sha256:${createHash("sha256").update(JSON.stringify(PROGRAM_CARD_QUESTION)).digest("hex")}`;

const ASK_CARD_TOOL_NAME = "ask_glasses_card";

const DECIDED_V2_CARD =
  `This turn may suit a program card. Ask first: call ${ASK_CARD_TOOL_NAME} with one line on why a card beats a screen or a chat reply, and write no card unless the wearer says yes. If they say no, answer with a surface or in chat.`;

const SCOPE = SURFACE_DECISION_SCOPE;

function composeCardDecision(answers     ) {
  const a = answers && answers.program_card;
  if (!a || a.choice !== CARD_SHAPE || !Number.isFinite(a.confidence) || a.confidence < CARD_FLOOR) return null;
  return {
    block: `<surface_decision>\n${DECIDED_V2_CARD}\n</surface_decision>`,
    oneLine: `<surface_decision> ${DECIDED_V2_CARD} ${SCOPE} </surface_decision>`,
    decision: { shape: CARD_SHAPE, kind: null, slot: null, confidence: a.confidence, reason: null, line: "v2_card" },
  };
}

module.exports = { CARD_FLOOR, CARD_SHAPE, PROGRAM_CARD_QUESTION, JEV_CARD_QUESTIONS, CARD_QUESTION_DIGEST, ASK_CARD_TOOL_NAME, DECIDED_V2_CARD, composeCardDecision };
