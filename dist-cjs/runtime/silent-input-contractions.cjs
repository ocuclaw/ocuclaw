const SILENT_INPUT_CONTRACTIONS_VERSION = "contractions3613/f51-p20480/v2";

const SILENT_INPUT_CONTRACTION_SCORE_STEPS = 2;

const SILENT_INPUT_CONTRACTION_FORMS = Object.freeze([
  "I'm", "I'll", "I'd", "I've", "you're", "you'll", "you'd", "you've",
  "he's", "he'll", "he'd", "she's", "she'll", "she'd", "it's", "it'll",
  "we're", "we'll", "we'd", "we've", "they're", "they'll", "they'd", "they've",
  "that's", "that'll", "there's", "here's", "what's", "where's", "who's", "how's",
  "let's", "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't",
  "shouldn't", "isn't", "aren't", "wasn't", "weren't", "haven't", "hasn't", "hadn't",
  "could've", "would've", "should've",
]);

const SILENT_INPUT_CONTRACTION_SCORE_LEVELS = Object.freeze([
  43, 40, 40, 40, 41, 36, 38, 36, 39, 33, 35, 38, 32, 34, 42, 34,
  38, 36, 32, 35, 37, 32, 34, 36, 41, 33, 38, 35, 38, 32, 35, 29,
  39, 44, 40, 43, 40, 37, 39, 37, 36, 41, 37, 39, 34, 36, 35, 33,
  32, 32, 34,
]);

function silentInputContractionEntries() {
  const out = [];
  for (let i = 0; i < SILENT_INPUT_CONTRACTION_FORMS.length; i += 1) {
    const level = SILENT_INPUT_CONTRACTION_SCORE_LEVELS[i];
    out.push({
      word: SILENT_INPUT_CONTRACTION_FORMS[i],
      score: Math.pow(2, level / SILENT_INPUT_CONTRACTION_SCORE_STEPS) / 1e9,
    });
  }
  return out;
}

module.exports = { SILENT_INPUT_CONTRACTIONS_VERSION, SILENT_INPUT_CONTRACTION_SCORE_STEPS, SILENT_INPUT_CONTRACTION_FORMS, SILENT_INPUT_CONTRACTION_SCORE_LEVELS, silentInputContractionEntries };
