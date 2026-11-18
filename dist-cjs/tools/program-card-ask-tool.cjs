const { ASK_CARD_TOOL_NAME } = require("../domain/glasses-ui-jev-card.cjs");
const { PROGRAM_CARD_CAPABILITY, resolveToolSessionKey } = require("./program-card-tool.cjs");
const { CARD_ASK_CHANGE_WAIT_MS, CARD_PLAN_MIN_LINES, CARD_PLAN_ROWS, cardPlanLines, cardPlanParameterSchema, fitCardDirections, fitCardPlan, fitCardSites } = require("./program-card-plan.cjs");
const { CARD_ASK_TASK_NEXT, PROGRAM_CARD_BUILD_BRIEF, PROGRAM_CARD_SPRITES_CAPABILITY, PROGRAM_CARD_TEST_PLAYER_CAPABILITY, programCardGameGuide, programCardTaskGuide, programCardYesGuides } = require("./program-card-guide.cjs");
const { TASK_CARD_CASES } = require("./program-card-task-states.cjs");
const { composeCardHostHealthNext, composeCardNotOpenedNext, composeCardPhoneNext, parseCardHostHealth } = require("./program-card-health.cjs");
const { taskHardCaseBrief } = require("./program-card-task-cases.cjs");
const { CARD_ASK_TASK_ADD_NEXT, PROGRAM_CARD_TASK_ADD_GUIDE } = require("./glasses-ui-card-part-add.cjs");
const { CARD_ASK_TASK_FIX_NEXT, PROGRAM_CARD_TASK_FIX_GUIDE } = require("./glasses-ui-task-fix-build.cjs");
const { CARD_ASK_CHANGE_NEXT, CARD_CHANGE_CODES, CARD_CHANGE_NONE_NEXT, CARD_CHANGE_UNCLEAR_NEXT, changeRevisionNote } = require("./program-card-change.cjs");

const TASK_CARD_PLAN_MAX_LINES = 3;

const ASK_CARD_TOOL_DESCRIPTION = [
  "Ask the wearer whether to build them a program card: a small program on the glasses they work with taps (a timer with rounds, a game, a calculator, a quiz, a scorekeeper). Wearers call it a card or an app.",
  "Call it BEFORE writing any card, every time; never write a card without a yes from this ask.",
  "`reason`: one short line, in the wearer's terms, on why a card beats a screen or a chat reply for this ask.",
  "`title`: the card's name. `plan`: 3 to 5 short lines on what the card will do; the wearer reads them before saying yes, and they become the card's test requirements, so write each as something you can test.",
  "For a game, pass `game: true` and aim high: plan the deepest game the ask allows; the yes then brings the game guide.",

  "`say`: 2 to 3 short sentences on how you will build it, each starting with its action; they show after a yes.",

  "To change a saved card, pass `savedCard` (its name or id) and plan only the change.",

  "When the ask does not say what the card shows (\"a card for my morning\"), do not guess: leave `plan` out and pass `directions`, 2 or 3 of `{label, plan}`, each a different card with its own plan, one of them from the wearer's own data when a tool can read it. A `label` says what that card shows in a few words (for a beach day, \"Tide times and a swim timer\"), not a name for it. They pick one on the ask card; the yes names it in `picked`, with its plan.",

  "For a card that reads live data from a website, pass `sites`: its hostnames (\"api.open-meteo.com\"), 3 at most; the yes allows them (`sitesAllowed`).",
  "It shows the ask on the glasses and waits for the pick. yes: write the card now, to the plan. yes with `change`: the wearer said what to change; fold it in and write the card now, with no second ask. no: do not write a card; answer with a LiveUI surface or in chat. no_answer: end your turn with the same one-line ask in chat.",
].join(" ");

const askCardParametersSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 140,
      description: "One line: why a card beats a screen or a chat reply here.",
    },
    title: {
      type: "string",
      maxLength: 40,
      description: "The card's name, a few words (e.g. 'Tabata timer').",
    },
    plan: cardPlanParameterSchema,

    game: { type: "boolean" },
    jev: {
      type: "string",
      maxLength: 140,
      description: "Only for a card that will ask Jev: one line on what it asks Jev, e.g. 'uses Jev to sort headlines'.",
    },
    mcp: {
      type: "string",
      maxLength: 140,
      description: "Only for a card that will read MCP tools: one line on what it reads, e.g. 'reads your PostHog visits for the graph'.",
    },
    actions: {
      type: "string",
      maxLength: 140,
      description: "Only for a card with actions it hands to you on a tap: one line naming them, e.g. 'Send to Sam hands me the items left to message him'.",
    },

    say: {},

    savedCard: {},

    directions: {},

    sites: {},
  },
};

function sayLines(raw         )           {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/(?<=[.!?])\s+/) : [];
  return parts
    .map((part) => {
      const line = oneLine(part, Infinity);
      return line.length > 160 ? `${line.slice(0, 159).trimEnd()}…` : line;
    })
    .filter(Boolean)
    .slice(0, 3);
}

const ANSWERS_SYMBOL = Symbol.for("ocuclaw.programCards.askAnswers");

const CARD_ASK_TIMEOUT_MS = 60_000;

const CARD_ASK_LONGEST_MS = CARD_ASK_TIMEOUT_MS + CARD_ASK_CHANGE_WAIT_MS;

const CARD_YES_TTL_MS = 30 * 60_000;

function answersHost(scopeHost      = globalThis)                   {
  let m = Reflect.get(scopeHost, ANSWERS_SYMBOL);
  if (!(m instanceof Map)) {
    m = new Map();
    Reflect.set(scopeHost, ANSWERS_SYMBOL, m);
  }
  return m;
}

function lastCardAsk(sessionKey        , scopeHost      = globalThis) {
  return answersHost(scopeHost).get(sessionKey) || null;
}

function cardAskApproved(sessionKey        , now = Date.now(), scopeHost      = globalThis) {
  const last = lastCardAsk(sessionKey, scopeHost);
  return !!last && last.answer === "yes" && !last.spent && now - last.at <= CARD_YES_TTL_MS;
}

const ASK_CARD_FIRST_ERROR =
  `ask_card_first: nothing was sent. Call ${ASK_CARD_TOOL_NAME} first with one line on why a card beats a screen or a chat reply; write the card only after the wearer says yes. Each new card needs its own ask.`;

function cardAskGate(sessionKey        , now = Date.now(), scopeHost      = globalThis) {
  const last = lastCardAsk(sessionKey, scopeHost);
  if (!last || last.answer === "no" || last.spent || now - last.at > CARD_YES_TTL_MS) return ASK_CARD_FIRST_ERROR;
  return null;
}

function spendCardAsk(sessionKey        , scopeHost      = globalThis) {
  const last = lastCardAsk(sessionKey, scopeHost);
  if (last) last.spent = true;
}

function cardAskPlan(sessionKey        , scopeHost      = globalThis)                  {
  const last = lastCardAsk(sessionKey, scopeHost);

  return last && last.answer !== "no" && !last.change && Array.isArray(last.plan) && last.plan.length ? last.plan.slice() : null;
}

function cardAskGame(sessionKey        , scopeHost      = globalThis)                 {
  const last = lastCardAsk(sessionKey, scopeHost);
  return last && last.answer !== "no" && typeof last.game === "boolean" ? last.game : null;
}

function oneLine(value         , max        ) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

const WHILE_OPEN = " while open";

function mixedReadNote(note        , taskCard         ) {
  if (!taskCard || !note || /\bwhile (?:it'?s |it is |the card is )?open\b/i.test(note)) return note;
  return `${note.slice(0, 140 - WHILE_OPEN.length).trimEnd()}${WHILE_OPEN}`;
}

const NEXT                         = {
  yes: "The wearer said yes. Write the card now.",
  no: "The wearer said no. Do not write a card; answer with a LiveUI surface or in chat.",
  no_answer: "No answer on the glasses. End your turn with the same one-line ask in chat; write a card only after a yes.",
};

const CARD_ASK_NO_PHONE_NEXT =
  `${composeCardPhoneNext("no_client", { connected: false, cards: false })} The ask was not shown, so this is not a no. End your turn with the cause and the same one-line ask in chat; write a card only after a yes.`;

const CARD_ASK_NOT_ASKED = "not_asked";
const CARD_ASK_NOT_ASKED_NEXT =
  "The wearer was not asked: the plan names something this host cannot do now, so this is not a no. Either tell them the cause in one sentence, with the fix when someone can make it, and end your turn (ask again once they say it is fixed), or, if the card is worth having without it, ask again now with a plan that leaves it out.";

const NO_USE = /^\(?(?:none(?: (?:needed|used))?|no(?: (?:jev|mcp)(?: needed)?)?|nothing|nil|n\.?\/?a\.?|unused|not (?:used|needed|required|applicable)|[-–—]+)\)?[.!]?$/i;
const namesUse = (line        ) => !!line && !NO_USE.test(line);

const CARD_ASK_YES_WITH_NOTE =
  "The wearer said yes. Start your reply with one short sentence telling the wearer what the card will show, then write the card in the same reply.";

const CARD_ASK_YES_TO_PLAN =
  "The wearer said yes to the plan. Just before the write, say 2 to 3 short sentences to the wearer, as plain reply text, on how you will build it; they show one by one while the code is written. Then write the card, to the plan; its lines are the card's test requirements.";

const CARD_ASK_YES_WITH_CHANGE =
  "The wearer said yes to the plan with a change, in `change`. Fold the change into the plan and write the card now; do not ask again. Pass the changed plan's lines as the first Look's requirements.";

const CARD_ASK_YES_TO_PICK =
  "The wearer picked the direction in `picked`. Just before the write, say 2 to 3 short sentences to the wearer, as plain reply text, on how you will build it; they show one by one while the code is written. Then write that card, to `plan`; its lines are the card's test requirements. Its `title` is a short name for that card, never the ask's title, which named the choice.";

const CARD_ASK_YES_OWN_WORDS =
  "The wearer picked none of the directions and said what they want, in `change`. Write the card to their words now; do not ask again. Pass its plan's lines as the first Look's requirements. Its `title` is a short name for that card, never the ask's title, which named the choice.";

const CARD_ASK_CHANGE_YES = "The wearer said yes to the change.";

const CARD_ASK_YES_OWN_TURN =
  "The wearer said yes. The card is built in its own turn, which starts by itself when this one ends. Do not write the card now: end this turn with one short line telling the wearer the build is starting. In the build turn, do what `then` says.";

const GAME_WORDS = /\b(games?|play(?:ing|s)?|player)\b/i;

const OWN_WORDS_GAME = /\bgames?\b/i;
const CARD_ASK_GAME_NEXT = " It is a game: read gameGuide first, and aim high.";
function isGameAsk(title        , reason        , plan                 , flag          ) {

  if (flag === true || flag === "true") return true;
  return GAME_WORDS.test([title, reason, ...(plan || [])].join(" "));
}

function createCardAskHandler(deps     ) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const scopeHost = deps.scopeHost || globalThis;
  const notesOn = typeof deps.notesOn === "function" ? deps.notesOn : () => false;

  const phoneSays = (dep         ) => ()          => {
    try { return typeof dep === "function" && dep() === true; } catch (_) { return false; }
  };

  const spritesOn = phoneSays(deps.spritesOn);

  const testPlayerOn = phoneSays(deps.testPlayerOn);

  const taskCasesFor = (sessionKey        )           => {
    try {
      const card = typeof deps.taskCard === "function" ? deps.taskCard(sessionKey) : null;
      return (card && taskHardCaseBrief(card)) || [...TASK_CARD_CASES];
    } catch (_) {
      return [...TASK_CARD_CASES];
    }
  };
  return async function askCard(sessionKey        , params     ) {
    const reason = oneLine(params && params.reason, 140);
    const title = oneLine(params && params.title, 40);

    const jev = oneLine(params && params.jev, 140);

    let marker      = null;
    try {
      marker = typeof deps.taskFor === "function" ? deps.taskFor(sessionKey) || null : null;
    } catch (_) {
      marker = null;
    }

    const mcp = mixedReadNote(oneLine(params && params.mcp, 140), !!marker);

    const actions = oneLine(params && params.actions, 140);
    if (!reason) return { answer: "no_answer", next: "Give a one-line reason and ask again." };

    const needs = [...(namesUse(jev) ? ["jev"] : []), ...(namesUse(mcp) ? ["mcp"] : [])];
    if (!marker && needs.length && typeof deps.hostHealth === "function") {
      let rows          = null;
      try {
        rows = await deps.hostHealth(needs);
      } catch (_) {
        rows = null;
      }
      const why = composeCardHostHealthNext(rows);
      if (why) {

        answersHost(scopeHost).delete(sessionKey);

        try {
          if (typeof deps.askNotShown === "function") deps.askNotShown(sessionKey);
        } catch (_) {

        }
        if (typeof deps.emit === "function") {
          try {
            deps.emit({ answer: CARD_ASK_NOT_ASKED, why: parseCardHostHealth(rows).map((row) => `${row.part}:${row.reason}`).join(",") });
          } catch (_) {

          }
        }
        return { answer: CARD_ASK_NOT_ASKED, next: `${why} ${CARD_ASK_NOT_ASKED_NEXT}` };
      }
    }

    const rawSaved = params && (typeof params.savedCard === "number" ? String(params.savedCard) : params.savedCard);
    const savedQuery = !marker ? oneLine(rawSaved, 80) : "";

    if ((savedQuery || marker?.addTo || marker?.fix) && typeof deps.noDraftsWhy === "function") {
      let why = "";
      try {
        why = deps.noDraftsWhy(sessionKey) || "";
      } catch (_) {
        why = "";
      }
      if (typeof why === "string" && why) {
        answersHost(scopeHost).delete(sessionKey);
        try {
          if (typeof deps.askNotShown === "function") deps.askNotShown(sessionKey);
        } catch (_) {

        }
        if (typeof deps.emit === "function") {
          try {
            deps.emit({ answer: CARD_ASK_NOT_ASKED, why: "open:drafts_off" });
          } catch (_) {

          }
        }
        return { answer: CARD_ASK_NOT_ASKED, next: `Nothing was shown. ${composeCardNotOpenedNext(why)}` };
      }
    }
    let changeOf      = null;
    if (savedQuery && typeof deps.findSavedCard === "function") {
      let found      = null;
      try {
        found = await deps.findSavedCard(sessionKey, savedQuery);
      } catch (_) {
        found = null;
      }
      if (found?.status === "found" && found.card && typeof found.card.appId === "string") {
        changeOf = found.card;
      } else {
        const matches = Array.isArray(found?.matches) ? found.matches.map((card     ) => ({ name: card.name, id: card.appId })) : [];
        if (typeof deps.emit === "function") {
          try {
            deps.emit({ answer: matches.length ? CARD_CHANGE_CODES.unclear : CARD_CHANGE_CODES.none, why: null, matches: matches.length });
          } catch (_) {

          }
        }
        return matches.length
          ? { answer: CARD_CHANGE_CODES.unclear, matches, next: CARD_CHANGE_UNCLEAR_NEXT }
          : { answer: CARD_CHANGE_CODES.none, matches, next: CARD_CHANGE_NONE_NEXT };
      }
    }

    let fixAsk      = null;
    if (marker?.fix && typeof deps.taskFixAsk === "function") {
      try {
        fixAsk = deps.taskFixAsk(sessionKey) || null;
      } catch (_) {
        fixAsk = null;
      }
    }
    const notes = [fixAsk?.uses, jev, mcp, actions].filter(Boolean).join("; ");

    const asked = changeOf ? `Change ${changeOf.name}: ${reason}` : `${title ? `${title}: ${reason}` : reason}`;
    const question = fixAsk ? fixAsk.question : `${asked}${notes ? ` (${notes})` : ""}`;

    const directions = !marker && !changeOf && !fixAsk ? fitCardDirections(params && params.directions) : null;
    const fitted = fitCardPlan(params && params.plan) ?? (directions ? directions[0].plan : null);
    const planned = fitted && marker ? fitted.slice(0, TASK_CARD_PLAN_MAX_LINES) : fitted;
    const say = sayLines(params && params.say);

    const usesRows = notes ? 1 : 0;
    const sites = planned && !directions && !marker && !fixAsk
      ? fitCardSites(params && params.sites).slice(0, CARD_PLAN_ROWS - CARD_PLAN_MIN_LINES - usesRows) : [];
    const plan = planned && sites.length ? planned.slice(0, CARD_PLAN_ROWS - sites.length - usesRows) : planned;
    let result     ;
    try {
      result = await deps.presentCardAsk({
        sessionKey,
        question,

        reason,
        ...(say.length ? { say } : {}),
        timeoutMs: deps.timeoutMs || CARD_ASK_TIMEOUT_MS,
        ...(deps.changeWaitMs ? { changeWaitMs: deps.changeWaitMs } : {}),

        ...(plan ? { name: fixAsk?.name || changeOf?.name || title || null, plan, ...(notes ? { uses: notes } : {}), ...(fixAsk?.label ? { fix: fixAsk.label } : {}) } : {}),
        ...(directions ? { choices: directions } : {}),
        ...(sites.length ? { sites } : {}),
      });
    } catch (_) {
      result = { answer: "no_answer", reason: "failed" };
    }
    const answer = result && (result.answer === "yes" || result.answer === "no") ? result.answer : "no_answer";

    const choiceShown = !!directions && !!result && result.choiceShown === true;
    const picked = choiceShown && answer === "yes" && Number.isInteger(result.picked) ? directions[result.picked] || null : null;
    const planShown = !!(picked ? picked.plan : plan) && !!result && result.planShown === true;

    const change = answer === "yes" && planShown ? oneLine(result.change, 280) : "";

    const ownWords = choiceShown && !!change;
    const builtPlan = ownWords ? null : picked ? picked.plan : plan;
    const planLines = builtPlan ? cardPlanLines(builtPlan) : null;

    const asksGame = isGameAsk(title, reason, planLines, params && params.game);

    const ownGame = ownWords && OWN_WORDS_GAME.test(change);
    const cardGame = asksGame || (ownWords ? ownGame : isGameAsk(picked ? picked.label : "", change, null));

    const sitesAllowed                  = sites.length && answer === "yes"
      ? (Array.isArray(result.sitesAllowed) ? result.sitesAllowed.filter((host     ) => sites.includes(host)) : [])
      : null;

    const cardTitle = choiceShown ? (picked ? picked.label : "") : title;
    answersHost(scopeHost).set(sessionKey, {
      answer, reason, title: cardTitle || null, plan: planLines, game: cardGame, ...(change ? { change } : {}), at: now(),
    });

    const game = answer === "yes" && (asksGame || ownGame);

    if (game && !change && planLines && planLines.length && typeof deps.onGameYes === "function") {
      try { deps.onGameYes(sessionKey, { title: cardTitle || "", plan: planLines.slice(), request: "" }); } catch (_) {  }
    }

    const task = answer === "yes" && !!marker;
    if (typeof deps.emit === "function") {
      try {
        deps.emit({
          answer,
          why: answer === "no_answer" ? (result && result.reason) || "unknown" : null,
          ...(builtPlan ? { planLines: builtPlan.length, planShown, ...(change ? { changeChars: change.length } : {}) } : {}),

          ...(ownWords ? { ownWords: true, changeChars: change.length } : {}),

          ...(directions ? { directions: directions.length, choiceShown, picked: picked ? result.picked : null } : {}),

          ...(sites.length ? { sites: sites.length, sitesAllowed: sitesAllowed ? sitesAllowed.length : 0 } : {}),
          ...(answer === "yes" ? { game, gameFlag: params?.game === true || params?.game === "true" } : {}),
          ...(answer === "yes" ? { task } : {}),

          saySentences: say.length,
        });
      } catch (_) {

      }
    }

    let guide = "";
    try {
      guide = answer === "yes" && typeof deps.yesGuides === "function" ? String(deps.yesGuides() || "") : "";
    } catch (_) {
      guide = "";
    }

    let ownTurn = false;
    if (answer === "yes" && typeof deps.buildTurn === "function") {
      try {
        ownTurn = (await deps.buildTurn(sessionKey, {
          title: cardTitle || null,

          yesUnspent: () => cardAskApproved(sessionKey, now(), scopeHost),
        })) === true;
      } catch (_) {
        ownTurn = false;
      }
    }

    let taskAdd      = null;
    if (task && marker.addTo && typeof deps.taskAdd === "function") {
      try {
        taskAdd = (await deps.taskAdd(sessionKey)) || null;
      } catch (_) {
        taskAdd = null;
      }
    }

    let taskFix      = null;
    if (task && marker.fix && typeof deps.taskFix === "function") {
      try {
        taskFix = (await deps.taskFix(sessionKey)) || null;
      } catch (_) {
        taskFix = null;
      }
    }

    let taskStarter      = null;
    if (task && !marker.addTo && !marker.fix && typeof deps.taskStarter === "function") {
      try {
        taskStarter = deps.taskStarter(sessionKey) || null;
      } catch (_) {
        taskStarter = null;
      }
    }

    let cardChange      = null;
    if (changeOf && answer === "yes" && typeof deps.changeCard === "function") {
      const lines = [...(change ? [change] : []), ...(planLines || [])];
      try {
        cardChange = (await deps.changeCard(sessionKey, { appId: changeOf.appId, lines, note: changeRevisionNote(change, planLines) })) || null;
      } catch (_) {
        cardChange = null;
      }
    }
    const withGuide = (reply     ) => {
      if (answer !== "yes" && !change) return reply;
      if (taskAdd?.refused) return { ...reply, next: taskAdd.next, taskAdd };
      if (taskFix?.refused) return { ...reply, next: taskFix.next, taskFix };
      if (cardChange?.refused) return { ...reply, next: cardChange.next, cardChange };

      const unopened = (handOff     ) => typeof handOff?.openError === "string" && !handOff.draftId;
      if (unopened(taskAdd)) return { ...reply, next: composeCardNotOpenedNext(taskAdd.openWhy), taskAdd };
      if (unopened(taskFix)) return { ...reply, next: composeCardNotOpenedNext(taskFix.openWhy), taskFix };
      const briefed = { ...reply, ...(sitesAllowed ? { sitesAllowed } : {}), brief: PROGRAM_CARD_BUILD_BRIEF, ...(guide ? { card_guide: guide } : {}) };
      const gamed = game ? { ...briefed, next: briefed.next + CARD_ASK_GAME_NEXT, gameGuide: programCardGameGuide(spritesOn(), testPlayerOn()) } : briefed;

      const guided = task ? { ...gamed, next: gamed.next + CARD_ASK_TASK_NEXT, taskGuide: programCardTaskGuide(taskStarter).trim(),
        taskCases: taskCasesFor(sessionKey) } : gamed;

      const added = task && taskAdd ? { ...guided, next: guided.next + CARD_ASK_TASK_ADD_NEXT,
        taskAddGuide: PROGRAM_CARD_TASK_ADD_GUIDE.trim(), taskAdd } : guided;

      const fixed = task && taskFix ? { ...added, next: added.next + CARD_ASK_TASK_FIX_NEXT,
        taskFixGuide: PROGRAM_CARD_TASK_FIX_GUIDE.trim(), taskFix } : added;

      const changed = cardChange ? { ...fixed, next: `${CARD_ASK_CHANGE_YES}${game ? CARD_ASK_GAME_NEXT : ""}${CARD_ASK_CHANGE_NEXT}`, cardChange } : fixed;
      return ownTurn ? { ...changed, next: CARD_ASK_YES_OWN_TURN, then: changed.next } : changed;
    };

    if (change && choiceShown) return withGuide({ answer, change, next: CARD_ASK_YES_OWN_WORDS });
    if (change) return withGuide({ answer, plan: planLines, change, next: CARD_ASK_YES_WITH_CHANGE });
    if (picked) return withGuide({ answer, picked: picked.label, plan: planLines, next: CARD_ASK_YES_TO_PICK });
    if (answer === "yes" && planShown) return withGuide({ answer, plan: planLines, next: CARD_ASK_YES_TO_PLAN });
    let withNote = false;
    try {
      withNote = answer === "yes" && notesOn() === true;
    } catch (_) {
      withNote = false;
    }

    const unseen = answer === "no_answer" && result?.reason === "no_connected_client";
    return withGuide({ answer, ...(answer === "yes" && planLines ? { plan: planLines } : {}),
      next: withNote ? CARD_ASK_YES_WITH_NOTE : unseen ? CARD_ASK_NO_PHONE_NEXT : NEXT[answer] });
  };
}

function registerCardAskTool(api     , service     , opts                                                                                                         = {}) {
  const askCard = createCardAskHandler({
    ...(typeof opts.onGameYes === "function" ? { onGameYes: opts.onGameYes } : {}),
    yesGuides: () => programCardYesGuides((capability) =>
      typeof service.hasConnectedAppClientCapability === "function" && service.hasConnectedAppClientCapability(capability) === true, {
      hostDrawsFrames: typeof service.programCardFrameComplete === "function" && service.programCardFrameComplete() != null,
    }),
    spritesOn: () => typeof service.hasConnectedAppClientCapability === "function" &&
      service.hasConnectedAppClientCapability(PROGRAM_CARD_SPRITES_CAPABILITY) === true,
    testPlayerOn: () => typeof service.hasConnectedAppClientCapability === "function" &&
      service.hasConnectedAppClientCapability(PROGRAM_CARD_TEST_PLAYER_CAPABILITY) === true,
    presentCardAsk: (p     ) => service.presentCardAsk(p),

    ...(typeof service.programCardHostHealth === "function"
      ? { hostHealth: (parts          ) => service.programCardHostHealth(parts) } : {}),
    askNotShown: (sessionKey        ) => service.cardAskNotShown?.(sessionKey),
    notesOn: () => typeof service.cardBuildNotesOn === "function" && service.cardBuildNotesOn() === true,
    buildTurn: (sessionKey        , info     ) =>
      typeof service.planCardBuildTurn === "function" ? service.planCardBuildTurn(sessionKey, info) : false,
    taskFor: (sessionKey        ) => typeof service.cardBuildTaskFor === "function" ? service.cardBuildTaskFor(sessionKey) : null,

    taskCard: (sessionKey        ) => typeof service.cardBuildTestCard === "function" ? service.cardBuildTestCard(sessionKey) : null,

    taskStarter: (sessionKey        ) => typeof service.cardBuildStarter === "function" ? service.cardBuildStarter(sessionKey) : null,

    taskAdd: (sessionKey        ) => typeof service.cardBuildTaskAdd === "function" ? service.cardBuildTaskAdd(sessionKey) : null,

    taskFixAsk: (sessionKey        ) => typeof service.cardBuildTaskFixAsk === "function" ? service.cardBuildTaskFixAsk(sessionKey) : null,
    taskFix: (sessionKey        ) => typeof service.cardBuildTaskFix === "function" ? service.cardBuildTaskFix(sessionKey) : null,

    findSavedCard: (sessionKey        , query        ) =>
      typeof service.cardBuildFindSaved === "function" ? service.cardBuildFindSaved(sessionKey, query) : null,

    noDraftsWhy: (sessionKey        ) => typeof service.cardBuildNoDraftsWhy === "function" ? service.cardBuildNoDraftsWhy(sessionKey) : "",
    changeCard: (sessionKey        , change     ) =>
      typeof service.cardBuildChange === "function" ? service.cardBuildChange(sessionKey, change) : null,
    emit: (fields     ) => {
      if (typeof service.emitGlassesUiLifecycle === "function") {
        service.emitGlassesUiLifecycle("program_card_ask", "info", fields);
      }
    },
  });
  api.registerTool(
    (ctx     ) => {

      if (
        typeof service.hasConnectedAppClientCapability !== "function" ||
        service.hasConnectedAppClientCapability(PROGRAM_CARD_CAPABILITY) !== true
      ) {
        return null;
      }
      const sessionKey = resolveToolSessionKey(ctx, service);
      return {
        name: ASK_CARD_TOOL_NAME,
        description: ASK_CARD_TOOL_DESCRIPTION,
        parameters: askCardParametersSchema,

        async execute(_toolCallId     , params     ) {
          const result = await askCard(sessionKey, params);
          return { content: [{ type: "text", text: JSON.stringify(result) }] };
        },
      };
    },
    { name: ASK_CARD_TOOL_NAME },
  );
}

module.exports = { TASK_CARD_PLAN_MAX_LINES, ASK_CARD_TOOL_NAME, ASK_CARD_TOOL_DESCRIPTION, askCardParametersSchema, sayLines, CARD_ASK_TIMEOUT_MS, CARD_ASK_LONGEST_MS, CARD_YES_TTL_MS, lastCardAsk, cardAskApproved, ASK_CARD_FIRST_ERROR, cardAskGate, spendCardAsk, cardAskPlan, cardAskGame, mixedReadNote, CARD_ASK_NO_PHONE_NEXT, CARD_ASK_NOT_ASKED, CARD_ASK_NOT_ASKED_NEXT, CARD_ASK_YES_WITH_NOTE, CARD_ASK_YES_TO_PLAN, CARD_ASK_YES_WITH_CHANGE, CARD_ASK_YES_TO_PICK, CARD_ASK_YES_OWN_WORDS, CARD_ASK_CHANGE_YES, CARD_ASK_YES_OWN_TURN, CARD_ASK_GAME_NEXT, isGameAsk, createCardAskHandler, registerCardAskTool };
