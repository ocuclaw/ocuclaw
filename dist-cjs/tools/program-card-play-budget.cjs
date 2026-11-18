const PLAY_BUDGET = Object.freeze({
  pictureMs: 220,
  reactMs: 300,
  tapMs: 460,
  swipeMs: 180,
  spreadMs: 150,
  pressGapMs: 700,
  handsOffMs: 2000,
  firstDangerMs: 3000,
  steadyPressMs: 1000,
});

function playDelayMs(key                  = "tap", pictureMs         = PLAY_BUDGET.pictureMs)         {
  return Math.round(1.5 * pictureMs + PLAY_BUDGET.reactMs + (key === "tap" ? PLAY_BUDGET.tapMs : PLAY_BUDGET.swipeMs));
}

const s = (ms        , digits = 1)         => String(Number((ms / 1000).toFixed(digits)));

const PROGRAM_CARD_PACE_GUIDE =
  `Pace: the wearer plays about ${s(playDelayMs("tap"))} s late. The picture they see is about ${s(1.5 * PLAY_BUDGET.pictureMs)} s old, ` +
  `they need about ${s(PLAY_BUDGET.reactMs)} s to react, and a tap takes about ${s(PLAY_BUDGET.tapMs, 2)} s more to arrive ` +
  `(a swipe about ${s(PLAY_BUDGET.swipeMs, 2)} s, so give the move that must be quick to a swipe). Pace every game that moves on its own for that. ` +
  `Left alone after Start, or after any press, the player survives at least ${s(PLAY_BUDGET.handsOffMs)} s. ` +
  `Holding steady takes at most one press every ${s(PLAY_BUDGET.steadyPressMs)} s, and nothing ever needs two presses within ${s(PLAY_BUDGET.pressGapMs)} s: ` +
  `two quick taps reach the phone as one double tap, which goes back instead of pressing twice. ` +
  `The first thing that can end the run arrives ${s(PLAY_BUDGET.firstDangerMs)} s or more after Start. ` +
  `A press may land ${s(PLAY_BUDGET.spreadMs, 2)} s early or late and must still work, so size gaps, catch windows and timing targets for that, and give a strong enough move that one press is enough. ` +
  `These are floors, not targets: stay close to them, since a game much slower than this feels dull. ` +
  `Harder means more to track, a new kind of thing or a longer run, never less time than these. ` +
  `Asked for "fast", "hard" or "like the original", keep the original's proportions (gap to player, rise to fall) at these times, not its seconds on a phone. ` +
  `Test plays the game from Start as a wearer this late would, and a game that player cannot stay alive in fails it.`;

module.exports = { PLAY_BUDGET, playDelayMs, PROGRAM_CARD_PACE_GUIDE };
