const PROSE_LABEL_MAX_CHARS = 64;
const PROSE_INPUT_MAX_CHARS = 1200;

const OPENER_RE =
  /^(?:ok(?:ay)?|alright|all right|great|good|got it|sure|right|perfect|nice|understood|done|yes|yep|now|next|then|first(?:ly)?|second(?:ly)?|third(?:ly)?|finally|lastly|after that|meanwhile|also|so|and|but|to start|to begin|for now)\b[\s,.:;!—-]*/i;

const BASE_LEAD_RE =
  /^(?:i(?:['’]ll| will| shall)(?: now| just| first| next| then| also| quickly)?(?: go ahead and| need to| have to| try to| start by| begin by)?|i(?:['’]m| am) (?:now |just )?(?:going|about) to|i(?:['’]m| am) gonna|let me|lemme|let['’]?s|i (?:now )?(?:need|want|have|plan|intend) to|i(?:['’]d| would) like to|i (?:should|can|must)|we(?:['’]ll| will| need to| should| can)|(?:my|the) next step is to|next up is to|time to|going to)\s+/i;

const GERUND_LEAD_RE =
  /^(?:i(?:['’]m| am)(?: now| just| currently| still)?|we(?:['’]re| are)(?: now)?|currently|still)\s+(?=[a-z-]+ing\b)/i;

const FILLER_RE =
  /^(?:now|just|first|next|then|also|quickly|briefly|simply|actually|go ahead and|try to|try and|start by|begin by|start off by|proceed to)\s+/i;

const PHRASE_VERBS                          = [
  [/^(?:take|have) a (?:quick |closer |brief )?look at\s+/i, "looking at "],
  [/^(?:take|have) a (?:quick |closer |brief )?look\b\s*/i, "looking "],
  [/^double[- ]check\s+/i, "double-checking "],
  [/^start (?:with|on)\s+/i, "starting with "],
  [/^see (?:if|whether)\s+/i, "checking whether "],
  [/^find out\s+/i, "finding out "],
];

const IRREGULAR_GERUNDS                         = {
  be: "being",
  see: "seeing",
  die: "dying",
  lie: "lying",
  tie: "tying",
  commit: "committing",
  submit: "submitting",
  begin: "beginning",
  format: "formatting",
  reset: "resetting",
  rerun: "rerunning",
  debug: "debugging",
  unzip: "unzipping",
  quit: "quitting",
  refer: "referring",
  transfer: "transferring",
  input: "inputting",
  output: "outputting",
  setup: "setting up",
};

const IMPERATIVE_VERBS = new Set(
  (
    "add analyze apply ask build calculate change check clean clear clone close collect commit compare " +
    "compile compute confirm connect convert copy count create debug delete deploy detect determine " +
    "diff display download dump edit enable ensure examine execute explore export extract fetch filter " +
    "find fix format gather generate get grab identify import inspect install launch list load locate log " +
    "look make measure merge move open parse peek ping print probe pull push query read rebuild record " +
    "refresh remove rename replace reproduce request reset restart restore retrieve review run save scan " +
    "search see send set show sort start stop summarize sync tail test trace try update upload validate " +
    "verify view watch write"
  ).split(" "),
);

function isVowel(ch        , index        ) {
  return "aeiou".includes(ch) || (ch === "y" && index > 0);
}

function vowelGroups(word        ) {
  let groups = 0;
  let inGroup = false;
  for (let i = 0; i < word.length; i += 1) {
    const vowel = isVowel(word[i], i);
    if (vowel && !inGroup) groups += 1;
    inGroup = vowel;
  }
  return groups;
}

function gerund(verb        )         {
  const hyphen = verb.lastIndexOf("-");
  if (hyphen > 0 && hyphen < verb.length - 1) {
    return verb.slice(0, hyphen + 1) + gerund(verb.slice(hyphen + 1));
  }
  const word = verb.toLowerCase();
  if (!/^[a-z]+$/.test(word)) return verb;
  if (word.endsWith("ing") && word.length > 4) return word;
  const irregular = IRREGULAR_GERUNDS[word];
  if (irregular) return irregular;
  if (word.endsWith("ie")) return `${word.slice(0, -2)}ying`;
  if (/(?:ee|ye|oe)$/.test(word)) return `${word}ing`;
  if (word.endsWith("e") && word.length > 2) return `${word.slice(0, -1)}ing`;
  const n = word.length;
  if (
    n >= 3 &&
    vowelGroups(word) === 1 &&
    !isVowel(word[n - 1], n - 1) &&
    !"wxy".includes(word[n - 1]) &&
    isVowel(word[n - 2], n - 2) &&
    !isVowel(word[n - 3], n - 3)
  ) {
    return `${word}${word[n - 1]}ing`;
  }
  return `${word}ing`;
}

function cleanText(raw         ) {
  if (typeof raw !== "string") return "";
  const bounded = raw.length > PROSE_INPUT_MAX_CHARS ? raw.slice(0, PROSE_INPUT_MAX_CHARS) : raw;
  return bounded
    .replace(/<[^>\n]{1,80}>/g, " ")
    .replace(/[*_`]+/g, "")
    .replace(/^\s*(?:[-•>#]+|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitSentences(text        ) {
  return text
    .split(/(?<=[.!?:;])\s+|\s+[—–]\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripOpeners(sentence        ) {
  let rest = sentence;
  for (let i = 0; i < 4; i += 1) {
    const next = rest.replace(OPENER_RE, "");
    if (next === rest || !next) break;
    rest = next;
  }
  return rest;
}

function stripFillers(phrase        ) {
  let rest = phrase;
  for (let i = 0; i < 3; i += 1) {
    const next = rest.replace(FILLER_RE, "");
    if (next === rest || !next) break;
    rest = next;
  }
  return rest;
}

const CLAUSE_END_RE =
  /\s*(?:[,;]|\s[—–-]\s|\s(?:and then|then|so that|so i can|so we can|because|since|before|after which|which will|while i)\s|\s(?:in order )?to (?:see|confirm|verify|check|find out|find|make sure|understand|determine|learn|know|ensure|get a sense)\b)/i;

const SECOND_ACTION_VERBS = new Set(["think", "report", "tell", "explain", "share", "note", "let", "wait", "come"]);

function secondActionIndex(phrase        ) {
  const joined = /\sand\s+(?:i'll\s+|i will\s+|then\s+)?([a-z-]+)\b/gi;
  for (let match = joined.exec(phrase); match; match = joined.exec(phrase)) {
    const word = match[1].toLowerCase();
    if (IMPERATIVE_VERBS.has(word) || SECOND_ACTION_VERBS.has(word)) return match.index;
  }
  return -1;
}

function firstClause(phrase        ) {
  const match = CLAUSE_END_RE.exec(phrase);
  const second = secondActionIndex(phrase);
  const cuts = [match ? match.index : -1, second].filter((index) => index > 0);
  if (cuts.length === 0) return phrase;
  const head = phrase.slice(0, Math.min(...cuts)).trim();
  return head.split(/\s+/).length >= 2 ? head : phrase;
}

function tidy(phrase        ) {
  return phrase
    .replace(/[\s.!?:;,…]+$/g, "")
    .replace(/\s+(?:first|now|next|as well|too|for you|real quick|right away|again now)$/i, "")
    .replace(/[\s.!?:;,]+$/g, "")
    .trim();
}

const CUT_BREAK_RE =
  /\s+(?:and|or|but|so|when|while|whether|if|after|before|until|where|which|that|minus|plus|than|as|in|inside|from|for|with|using|via|to|on|at|under|within|across|through|by|against|into|about)\s+/gi;

const DANGLING_TAIL_RE =
  /(?:\s+(?:and|or|but|so|when|while|whether|if|after|before|until|where|which|that|minus|plus|than|as|the|a|an|to|of|for|with|in|on|at|by|from|into|about|its|their|my|your|our|this|these|those|i|we|just|then|right))+$/i;

function clip(phrase        , maxChars        ) {
  if (phrase.length <= maxChars) return phrase;
  const room = phrase.slice(0, maxChars + 1);
  let best = -1;
  CUT_BREAK_RE.lastIndex = 0;
  for (let match = CUT_BREAK_RE.exec(room); match; match = CUT_BREAK_RE.exec(room)) {
    const head = room.slice(0, match.index).replace(/[\s,;:—-]+$/g, "");
    if (head.length >= maxChars * 0.4 && head.split(/\s+/).length >= 3 && !DANGLING_TAIL_RE.test(head)) {
      best = match.index;
    }
  }
  if (best > 0) return room.slice(0, best).replace(/[\s,;:—-]+$/g, "");
  const space = room.lastIndexOf(" ");
  const cut = (space > maxChars * 0.5 ? room.slice(0, space) : phrase.slice(0, maxChars)).replace(/[\s,;:—-]+$/g, "");
  const kept = cut.replace(DANGLING_TAIL_RE, "").replace(/[\s,;:—-]+$/g, "");
  return kept.split(/\s+/).length >= 2 ? kept : cut;
}

const BATCH_CLAUSE_END_RE =
  /\s*(?:;|\s[—–-]\s|,?\s(?:and then|then|so that|so i can|so we can|because|since|before|after which|which will|while i|but|although|though|whereas|which|unless)\s|,?\s(?:in order )?to (?:see|confirm|verify|check|find out|find|make sure|understand|determine|learn|know|ensure|get a sense)\b)/i;

function batchClause(phrase        ) {
  const match = BATCH_CLAUSE_END_RE.exec(phrase);
  if (!match || match.index <= 0) return phrase;
  const head = phrase.slice(0, match.index).trim();
  return head.split(/\s+/).length >= 2 ? head : phrase;
}

function gerundLaterActions(phrase        , moreVerbs                      ) {
  return phrase.replace(/(,\s*(?:and\s+)?(?:then\s+)?|\s(?:and\s+)?then\s+|\sand\s+)([A-Za-z][A-Za-z-]*)\b/g, (whole, joint, word) => {
    const verb = word.toLowerCase();

    if (/^[A-Z]/.test(word)) return whole;
    return IMPERATIVE_VERBS.has(verb) || moreVerbs?.has(verb) ? `${joint}${gerund(word)}` : whole;
  });
}

function clipAtListItem(phrase        , budget        ) {
  if (phrase.length <= budget) return phrase;
  const joints = /,\s*(?:and\s+)?|\s+and\s+/g;
  let best = -1;
  for (let match = joints.exec(phrase); match; match = joints.exec(phrase)) {
    if (match.index > budget) break;
    if (phrase.slice(0, match.index).trim().split(/\s+/).length >= 2) best = match.index;
  }
  return best > 0 ? phrase.slice(0, best).trim() : phrase;
}

function finish(phrase        , maxChars        , keepList = false) {
  const clause = keepList ? clipAtListItem(batchClause(phrase), Math.max(8, maxChars - 3)) : firstClause(phrase);
  const tidied = tidy(clause);
  if (tidied.split(/\s+/).length < 2) return null;
  const clipped = clip(tidied, Math.max(8, maxChars - 3));
  if (!clipped) return null;
  return `${clipped.charAt(0).toUpperCase()}${clipped.slice(1)}...`;
}

const DROPPABLE_WORD_RE =
  /\s+(?:the|a|an|your|my|our|its|their|this|that|these|those|current|currently|quickly|carefully|briefly|actual|actually|just)(?=\s)/gi;

const TAIL_BREAK_RE =
  /\s+(?:in|inside|from|for|with|using|via|to|so|on|at|under|within|across|through|by|against|that|which|whether|if|and|or|into|about)\s+/gi;

const FIT_STEPS = [40, 26];

function fitCandidates(label        ) {
  const core = label.replace(/\.{3}$|…$/, "").trim();
  if (!core) return [];
  const out = [core];
  const lean = core.replace(DROPPABLE_WORD_RE, "").replace(/\s+/g, " ").trim();
  if (lean && lean !== core) out.push(lean);
  const base = lean || core;
  const cuts           = [];
  TAIL_BREAK_RE.lastIndex = 0;
  let match = TAIL_BREAK_RE.exec(base);
  while (match) {

    const head = base.slice(0, match.index).replace(/[\s,;:]+$/, "").trim();
    if (head.split(/\s+/).length >= 2) cuts.push(head);
    match = TAIL_BREAK_RE.exec(base);
  }
  for (const step of FIT_STEPS) {
    const shortest = out[out.length - 1];
    if (shortest.length <= step) continue;
    const pick = cuts.filter((cut) => cut.length <= step).pop();
    if (pick && !out.includes(pick)) out.push(pick);
  }
  return out.slice(0, 4).map((entry) => `${entry.charAt(0).toUpperCase()}${entry.slice(1)}...`);
}

function withFits(label               , sentence        ) {
  if (!label) return null;
  const fits = fitCandidates(label);
  return { label, sentence, fits: fits.length > 1 ? fits : [] };
}

function verbPhraseToGerund(phrase        ) {
  for (const [pattern, replacement] of PHRASE_VERBS) {
    if (pattern.test(phrase)) return phrase.replace(pattern, replacement);
  }
  const match = /^([A-Za-z][A-Za-z-]*)(.*)$/s.exec(phrase);
  if (!match) return null;
  return `${gerund(match[1])}${match[2]}`;
}

function intentPhrase(sentence        , maxChars        , keepList = false) {
  const opened = stripOpeners(sentence);

  const baseLead = BASE_LEAD_RE.exec(opened);
  if (baseLead) {
    const rest = stripFillers(opened.slice(baseLead[0].length));

    const converted = verbPhraseToGerund(rest);
    if (!converted) return null;
    return finish(keepList ? gerundLaterActions(converted) : converted, maxChars, keepList);
  }
  const gerundLead = GERUND_LEAD_RE.exec(opened);
  if (gerundLead) return finish(opened.slice(gerundLead[0].length), maxChars, keepList);

  if (/^[A-Za-z-]+ing\s+\S/.test(opened) && !/^(?:during|according|regarding|considering that|nothing|something|anything|everything)\b/i.test(opened)) {
    return finish(opened, maxChars, keepList);
  }
  return null;
}

const PLAN_TALK_RE =
  /\b(?:steps?|commands|tasks?|things|everything|in (?:order|turn|sequence|parallel)|one (?:by one|at a time)|step by step|together|at once|all (?:two|three|four|five|six|\d+))\b/i;

const VAGUE_OBJECT_RE =
  /^\S+ (?:(?:at|through|into|up|on|in|for|over) )?(?:it|its|them|their|that|this|these|those|there|here|both)\b/i;

const BARE_VAGUE_RE =
  /^\S+(?: (?:at|through|into|up|on|in|for|over|around|back|out))? (?:it|them|that|this|these|those|there|here|both)(?: (?:again|out|up|now|over|through))?\.{3}$/i;

function shortenActivityProse(raw         , options      = {}) {
  const text = cleanText(raw);
  if (!text) return null;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 16
    ? options.maxChars
    : PROSE_LABEL_MAX_CHARS;
  const sentences = splitSentences(text);
  const ordered = options.pick === "last" ? sentences.slice().reverse() : sentences;
  for (const sentence of ordered) {
    const label = intentPhrase(sentence, maxChars);

    if (label && options.oneStep === true && (PLAN_TALK_RE.test(label) || VAGUE_OBJECT_RE.test(label))) continue;
    if (label && BARE_VAGUE_RE.test(label)) continue;
    if (label) return withFits(label, sentence);
  }
  return null;
}

const BATCH_WORDS_RE =
  /,?\s*\b(?:all at once|in parallel|in one go|at the same time|at once|(?<!\b(?:fits?|fitting|works?|working|go(?:es)?|going|ties?|tying|puts?|putting|comes?|coming|pieces?|piecing|hangs?|holds?|sticks?|belongs?|links?|brings?|pulls?|adds?|stitch(?:es)?|glues?)\s)together|concurrently|simultaneously|side by side)\b/gi;

const SEQUENCE_RE =
  /\b(?:then|afterwards?|after that|next|followed by|one (?:at a time|by one|after another)|step by step|in (?:order|turn|sequence)|first(?:ly)?|second(?:ly)?|finally|lastly)\b/i;

const NAMES_SEVERAL_RE = /,\s*\S|\sand\s+\S/i;

function shortenBatchProse(raw         , options      = {}) {
  const text = cleanText(raw);
  if (!text) return null;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 16
    ? options.maxChars
    : PROSE_LABEL_MAX_CHARS;
  const sentence = splitSentences(text)[0];
  if (!sentence) return null;
  const opened = stripOpeners(sentence);
  if (SEQUENCE_RE.test(opened)) return null;
  BATCH_WORDS_RE.lastIndex = 0;
  const together = BATCH_WORDS_RE.test(opened);
  BATCH_WORDS_RE.lastIndex = 0;
  if (!together && !NAMES_SEVERAL_RE.test(opened)) return null;
  const plain = sentence
    .replace(BATCH_WORDS_RE, "")
    .replace(/\s+([.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

    .replace(/,\s*[A-Za-z-]+ing([.!?]?)$/, "$1");
  const label = intentPhrase(plain, maxChars, true);

  if (!label || (VAGUE_OBJECT_RE.test(label) && label.split(/\s+/).length < 3)) return null;
  return withFits(label, sentence);
}

const STEP_MARKER_RE =
  /^(?:step|command|task|part|item)\s*#?\d+(?:\s*(?:of|\/)\s*\d+)?\s*[:.)–—-]*\s*/i;

function shortenToolPurpose(raw         , options      = {}) {
  const text = cleanText(raw).replace(STEP_MARKER_RE, "");
  if (!text) return null;
  const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 16
    ? options.maxChars
    : PROSE_LABEL_MAX_CHARS;
  const sentence = splitSentences(text)[0] || text;
  const intent = intentPhrase(sentence, maxChars);
  if (intent) return withFits(intent, sentence);
  const opened = stripOpeners(sentence);
  const first = /^([A-Za-z-]+)/.exec(opened);
  const firstWord = first ? first[1].toLowerCase() : "";
  const phrase = IMPERATIVE_VERBS.has(firstWord) || PHRASE_VERBS.some(([pattern]) => pattern.test(opened))
    ? verbPhraseToGerund(opened)
    : opened;
  const label = phrase ? finish(phrase, maxChars) : null;
  if (label) return withFits(label, sentence);
  const kept = clip(tidy(opened), maxChars - 3);
  return kept ? withFits(`${kept.charAt(0).toUpperCase()}${kept.slice(1)}...`, sentence) : null;
}

const NOT_AN_ACTION = new Set(
  "be not never need have want think guess assume hope wonder say admit bet know believe suspect".split(" "),
);

const LATER_NOTE_VERBS = new Set(
  "adjust animate catch draw handle highlight keep polish randomize reorder resize rework shrink simplify tighten"
    .split(" "),
);

const LEAD_NOTE_VERBS = new Set("label track treat".split(" "));

function noteInActionVoice(sentence        , imperative = false) {
  const opened = stripOpeners(sentence);
  let action                = null;
  const baseLead = BASE_LEAD_RE.exec(opened);
  const bare = /^([A-Za-z-]+)\b/.exec(opened);
  const bareVerb = bare ? bare[1].toLowerCase() : "";
  if (!baseLead && imperative && (IMPERATIVE_VERBS.has(bareVerb) || LATER_NOTE_VERBS.has(bareVerb) || LEAD_NOTE_VERBS.has(bareVerb))) {
    const converted = verbPhraseToGerund(opened);
    action = converted ? gerundLaterActions(converted, LATER_NOTE_VERBS) : null;
  } else if (baseLead) {
    const rest = stripFillers(opened.slice(baseLead[0].length));
    const verb = /^([A-Za-z-]+)\b/.exec(rest);
    const word = verb ? verb[1].toLowerCase() : "";
    const known = PHRASE_VERBS.some(([pattern]) => pattern.test(rest)) ||
      (word !== "" && !NOT_AN_ACTION.has(word) && !/ly$/.test(word));
    const converted = known ? verbPhraseToGerund(rest) : null;
    action = converted ? gerundLaterActions(converted, LATER_NOTE_VERBS) : null;
  } else {
    const gerundLead = GERUND_LEAD_RE.exec(opened);
    if (gerundLead) action = opened.slice(gerundLead[0].length);
  }
  if (!action || !/^[A-Za-z]/.test(action)) return sentence;
  return `${action.charAt(0).toUpperCase()}${action.slice(1)}`;
}

function progressNoteInActionVoice(text         , options                           = {}) {
  if (typeof text !== "string" || !text.trim()) return text;
  const imperative = options.imperative === true;

  return text
    .split(/(?<=[.!?…])(\s+)/)
    .map((part) => {
      if (!part || /^\s+$/.test(part)) return part;
      const lead = /^\s*/.exec(part) [0];
      return lead + noteInActionVoice(part.slice(lead.length), imperative);
    })
    .join("");
}

const BOLD_HEADING_LINE = /^\s*\*\*([^*\n]+)\*\*\s*$/;
const LEADING_BOLD_HEADING = /^\s*\*\*([^*\n]+)\*\*\s+(?=\S)/;

function splitBoldHeading(raw         )                                                  {
  if (typeof raw !== "string" || !raw.trim()) return { heading: null, text: null };
  let heading                = null;
  const kept           = [];
  for (const line of raw.split("\n")) {
    const own = BOLD_HEADING_LINE.exec(line);
    const lead = own ? null : LEADING_BOLD_HEADING.exec(line);
    if (own) heading = own[1];
    else if (lead) {
      heading = lead[1];
      kept.push(line.slice(lead[0].length));
    } else kept.push(line);
  }
  const text = kept.join("\n").trim();
  return { heading: heading ? heading.replace(/\s+/g, " ").trim() || null : null, text: text || null };
}

module.exports = { PROSE_LABEL_MAX_CHARS, fitCandidates, gerund, progressNoteInActionVoice, shortenActivityProse, shortenBatchProse, shortenToolPurpose, splitBoldHeading };
