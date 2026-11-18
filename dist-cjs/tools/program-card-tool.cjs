const { createHash } = require("node:crypto");

const { AsyncLocalStorage } = require("node:async_hooks");
const { PROGRAM_CARD_DRAFT_TOOL, PROGRAM_CARD_DRAFT_DESCRIPTION, programCardDraftParametersSchema } = require("./program-card-drafts.cjs");
const { isCodeModeNestedToolCallId, isEvenAiAgentSession } = require("./glasses-ui-tool.cjs");
const { PROGRAM_CARD_GUIDE, PROGRAM_CARD_JEV_GUIDE, PROGRAM_CARD_JEV_ON_LINE, PROGRAM_CARD_KIT_GUIDE, PROGRAM_CARD_MCP_GUIDE, PROGRAM_CARD_LOOK_GUIDE, PROGRAM_CARD_LOOK_POINTER, PROGRAM_CARD_LOOK_CODE_PICTURES, PROGRAM_CARD_LIVE_CAPTURE_GUIDE, PROGRAM_CARD_FIRMWARE_TEXT_GUIDE, PROGRAM_CARD_FIRMWARE_FONT_ESTIMATE, PROGRAM_CARD_FIRMWARE_FONT_EXACT, programCardMcpOnLines } = require("./program-card-guide.cjs");
const { PROGRAM_CARD_ACTIONS_CAPABILITY, PROGRAM_CARD_ACTIONS_GUIDE, PROGRAM_CARD_ACTIONS_ON_LINE, PROGRAM_CARD_HOST_COMMANDS_ON_LINE } = require("./program-card-guide.cjs");
const { PROGRAM_CARD_MODELS_3D_CAPABILITY, PROGRAM_CARD_PICTURES_CAPABILITY, programCardPicturesGuide } = require("./program-card-guide.cjs");
const { createProgramCardFrameLane, programCardFrameLayout, PROGRAM_CARD_FRAME_DRAW_CAPABILITY, PROGRAM_CARD_FRAME_IDEA_CAPABILITY, frameDetailOf } = require("./program-card-frame-lane.cjs");
const { FRAME_SURFACE_PREFIX, frameFitsUpgrade, isFrameWrapped, wrapProgramCardFrame } = require("./program-card-frame-wire.cjs");
const { FRAME_CANNOT_CODES, looksLikeGame } = require("./program-card-frame-redo.cjs");
const { FRAME_GRID_CELLS, FRAME_SCREEN_CELLS, frameScreenFromGrid } = require("./program-card-frame-save.cjs");
const { createOpenCardHook, createOpenCardStore, OPEN_CARD_SOURCE_CAP, programCardCheckAskOf, programCardDoneSaves } = require("./program-card-context.cjs");
const { bundledCardFixPlaybookFile } = require("./program-card-fix-playbook.cjs");
const { composeCardHealthNext, PROGRAM_CARD_ACCESS_WHERE, withCardPhoneWhy } = require("./program-card-health.cjs");
const { PROGRAM_CARD_AGENT_REFRESH_NOT_ALLOWED, PROGRAM_CARD_AGENT_REFRESH_NOT_DECLARED } = require("./glasses-ui-program-card-agent-refresh.cjs");

const PROGRAM_CARD_REFRESH_COMMAND = "refresh";
const { PROGRAM_CARD_DESCRIPTION_MAX, liveuiLibraryDigest, normalizeProgramCardAsks } = require("./glasses-ui-library.cjs");
const { rememberProgramCardDescription, beginProgramCardAsks, finishProgramCardAsks, rememberOpenProgramCardAsks, linkPlanIconToSource, PROGRAM_CARD_READY_ASKS_MS, PROGRAM_CARD_READY_NOT_SHOWN } = require("./program-card-saves.cjs");
const { planRequirements } = require("./program-card-plan.cjs");
const { CARD_CHANGE_REPLACES_MAX } = require("./program-card-change.cjs");
const { programCardEditResentNext, programCardEditShape } = require("./program-card-edit-shape.cjs");
const { programCardApplyEdits, programCardKitRefusal, PROGRAM_CARD_KEPT_REFUSAL_MS, PROGRAM_CARD_REFUSED_FIXED_NEXT, PROGRAM_CARD_REFUSED_KEPT_EDIT_NOTE, PROGRAM_CARD_REFUSED_KEPT_NEXT } = require("./program-card-kit-check.cjs");
const { programCardTaskStatesRefusal } = require("./program-card-task-states.cjs");
const { taskCaseVerdict, taskCaseVerdictNext, taskHardCases } = require("./program-card-task-cases.cjs");
const { PROGRAM_CARD_MCP_CAPABILITY } = require("./glasses-ui-program-card-mcp.cjs");
const { REQUEST_CARD_MCP_WRITE_TOOL_DESCRIPTION, REQUEST_CARD_MCP_WRITE_TOOL_NAME, createRequestCardMcpWriteHandler, programCardMcpWriteGate, programCardSourceAfterEdits, requestCardMcpWriteParametersSchema } = require("./program-card-mcp-writes.cjs");
const { REQUEST_HOST_COMMAND_TOOL_DESCRIPTION, REQUEST_HOST_COMMAND_TOOL_NAME, createRequestHostCommandHandler, requestHostCommandParametersSchema } = require("./program-card-host-commands.cjs");
const { REQUEST_CARD_SETUP_TOOL_DESCRIPTION, REQUEST_CARD_SETUP_TOOL_NAME, createRequestCardSetupHandler, requestCardSetupParametersSchema } = require("./program-card-setup-requests.cjs");
const { createProgramCardLookHistory, programCardTestCouldNotRun, LOOK_GLASSES_CARD_TOOL_NAME, lookGlassesCardParametersSchema, LOOK_PICTURES_UNCHANGED_NOTE, lookPicturesNotYetSent, lookReportWithoutPixels, lookResultForModel, withLookStateLimitProblem, lookToolImageContent, lookToolPictures, isWearerOnlyLine, matchLookRequirement, programCardImageModel, PROGRAM_CARD_FIRMWARE_TEXT_CAPABILITY, PROGRAM_CARD_LOOK_CAPABILITY, PROGRAM_CARD_LOOK_PLAY_CAPABILITY, PROGRAM_CARD_LOOK_PLAY_RUN_CAPABILITY, withoutPlayHints, PROGRAM_CARD_LOOK_PLAY_RUN_UNSUPPORTED, PROGRAM_CARD_LOOK_PLAY_UNSUPPORTED, PROGRAM_CARD_SPECK_PROPERTY, isPlayStep, PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY, PROGRAM_CARD_LOOK_TIMEOUT_MS, withGameLive, PROGRAM_CARD_LOOK_CASES_CAPABILITY, PROGRAM_CARD_LOOK_CASES_HOST_MS, validateLookCases, lookCasesDebug, projectProgramCardLookDriveReceipt, validateLookInput, validateLookReport, validateProgramCardCapture } = require("./program-card-look.cjs");
const { createProgramCardLookDriveController, isProgramCardLookDriveInput, PROGRAM_CARD_LOOK_DRIVE_CAPABILITY, PROGRAM_CARD_LOOK_DRIVE_GUIDE, PROGRAM_CARD_LOOK_DRIVE_MAX_CALLS, validateProgramCardLookDriveResult } = require("./program-card-look-drive.cjs");
const { embedProgramCardPictureFiles, programCardPictureFilePaths } = require("./program-card-picture-files.cjs");
const { hostFirstTest, isDirectInputSource, provesVerdicts, shiftProves, splitProves } = require("./program-card-host-test.cjs");
const { liveCheckDebug, liveCheckForAgent, liveCheckNext, liveFeedParts, liveGate, liveHealthRefined, liveMcpCalled, liveOnlyFailed, liveUseParts } = require("./program-card-live-check.cjs");

const PROGRAM_CARD_CAPABILITY = "programCardsV1";
const WRITE_GLASSES_CARD_TOOL_NAME = "write_glasses_card";
const GLASSES_CARD_COMMAND_TOOL_NAME = "glasses_card_command";
const EDIT_GLASSES_CARD_TOOL_NAME = "edit_glasses_card";
const DEFAULT_PROGRAM_CARD_TIMEOUT_MS = 15_000;
const PROGRAM_CARD_LIMITS = Object.freeze({
  titleMax: 40,
  whyMax: 300,
  sourceMax: 131_072,
  editsMax: 20,
});

const cardAsksSchema = {
  type: "object",
  properties: {
    request: { type: "string", maxLength: 500, description: "The wearer's own words about the card." },
    requirements: { type: "array", maxItems: 6, items: { type: "string", maxLength: 80 }, description: "What the wearer wants this card to do, kept for future reviews." },
  },
  additionalProperties: false,
};

const programCardParametersSchema = {
  type: "object",
  required: ["title", "source"],
  properties: {

    speck: PROGRAM_CARD_SPECK_PROPERTY,
    title: {
      type: "string",
      minLength: 1,
      maxLength: PROGRAM_CARD_LIMITS.titleMax,
      description: "A short name for the card, such as Tea timer.",
    },

    why: {
      type: "string",
      maxLength: PROGRAM_CARD_LIMITS.whyMax,
      description: "Optional: one line on why a card beats a screen or a chat reply here, like the ask's reason.",
    },
    userAgreed: {
      type: "boolean",
      description: "Optional: leave it out. The wearer's yes to ask_glasses_card is the consent.",
    },
    source: {
      type: "string",
      minLength: 1,
      maxLength: PROGRAM_CARD_LIMITS.sourceMax,
      description: "The card's JavaScript source.",
    },
    description: {
      type: "string",
      maxLength: PROGRAM_CARD_DESCRIPTION_MAX,
      description:
        "One line on what the card does, for its LiveUI Library entry if the wearer saves it, such as: Counts down tea steeping and chimes when it is ready.",
    },
    asks: cardAsksSchema,
  },
  additionalProperties: false,
};

const PROGRAM_CARD_WHEN = [
  "Offer a card, rather than a LiveUI surface, when the wearer will work it themselves with taps, again and again, and it keeps its own state or logic between taps:",
  "a timer with rounds, phases or laps; a game; a calculator or converter with inputs they adjust; a quiz or flashcards that reveal answers or keep score; a scorekeeper, counter or running total, with undo; or a drawing that moves or steps.",
  "For these, offer the card even when a surface could roughly do it; the wearer can still say no.",
  "Do not offer one for something they only read, pick from once, tick off or glance at; one plain timer or countdown; one computed answer; an explanation; or choosing one value to start something.",
  "But when the wearer asks for a card or an app (\"make me a card\", \"build me an app\"), ask with ask_glasses_card even for those: their yes or no settles it.",
].join(" ");

const PROGRAM_CARD_JEV_RESULT_LINE =
  "With Jev questions, the call also waits up to a minute for the wearer to allow them and returns jev (allowed, declined, no_answer or off) and next, what to tell the wearer.";

const PROGRAM_CARD_MCP_RESULT_LINE =
  "With MCP uses, the call also waits up to a minute for the wearer to allow them and returns mcp (allowed, declined, no_answer, off or invalid) and next, what to tell the wearer.";

const PROGRAM_CARD_MODEL_RESULT_LINE =
  "With model uses, the call waits up to a minute for the wearer to allow them and returns model (allowed, declined, no_answer, off, unavailable or invalid) and next, what to tell the wearer.";

const WRITE_GLASSES_CARD_TOOL_DESCRIPTION = [
  "Tap-run card: games, quizzes, scorers, calculators, timers.",
  "Put a small interactive program (a card) on the wearer's glasses.",
  "Call it only after ask_glasses_card returns yes for this card; one yes covers one new card. Returns { ok, shown, error }.",
  "The phone compiles and runs the card when you call this and returns any error, so write it straight into this call: no files, terminal or test runs first.",

  "",
  PROGRAM_CARD_GUIDE,
  PROGRAM_CARD_KIT_GUIDE,

  PROGRAM_CARD_JEV_GUIDE,
  PROGRAM_CARD_JEV_RESULT_LINE,

  PROGRAM_CARD_MCP_GUIDE,
  PROGRAM_CARD_MCP_RESULT_LINE,
  PROGRAM_CARD_MODEL_RESULT_LINE,
].join("\n");

const WEARER_NO = new Set(["declined", "kept_off", "removed"]);

const JEV_NEXT                         = {
  allowed: "The wearer allowed this card's Jev questions; its asks get answers now.",
  declined: `The wearer said not now to Jev for this card: its asks answer not_allowed. Offer a version without Jev, or tell them they can allow it on the phone (${PROGRAM_CARD_ACCESS_WHERE}).`,
  no_answer: `The wearer did not answer the Jev request yet: the card waits (ctx.jev is waiting). They can allow it on the phone (${PROGRAM_CARD_ACCESS_WHERE}).`,
  off: `Jev in cards is off on this host or no TypeSafe key is saved, so the card's asks answer off. The wearer can turn on Jev in cards (${PROGRAM_CARD_ACCESS_WHERE}).`,
};

const AGENT_REFRESH_NEXT                         = {
  allowed: "The wearer let you press this card's Refresh; each press runs its Task and counts against that Task's daily agent cap.",
  declined: "The wearer said no to your Refresh on this card: only they can tap it. They can change that on the card's What it uses page.",

  no_answer: "The wearer did not answer whether you may press this card's Refresh, so you may not yet. Writing the card again asks them once more.",
  invalid: "The host could not ask about this card's Refresh, so you may not press it.",
};

const MCP_NEXT                         = {
  allowed: "The wearer allowed this card's MCP reads; its calls get answers now.",
  declined: `The wearer said not now to this card's MCP reads: its calls answer not_allowed. Offer a version without them, or tell them they can allow it on the phone (the saved card's page, or ${PROGRAM_CARD_ACCESS_WHERE}).`,
  no_answer: `The wearer did not answer the request yet: the card waits (ctx.mcp is waiting). They can allow it on the phone (${PROGRAM_CARD_ACCESS_WHERE}).`,
  off: `MCP in cards is off on this host, or a server the card reads is not connected, so its calls answer off. The wearer can turn on MCP in cards (${PROGRAM_CARD_ACCESS_WHERE}).`,
};

const MCP_WRITES_NEXT                         = {
  allowed: "The card's writes carry the wearer's grant; each send still asks the wearer on the glasses, and only from their own input.",
  not_granted: "A write use of this card has no grant from the wearer, so its write calls answer not_allowed. Call request_card_mcp_write with that exact use.",
  off: "Card writes are off here (MCP in cards is off, the phone cannot show the send prompt yet, or this host cannot send), so the card's write calls answer off.",
};

const glassesCardCommandParametersSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 80, description: "A command id from the open card's command list." },
    args: {
      type: "object",
      description: 'Its arguments: {"value": n} for a number command, or the args the list shows.',
    },
    capture: { type: "boolean", description: "Also return the first settled SDK-accepted picture after this command, when the phone supports live capture." },
  },
  additionalProperties: false,
};

const GLASSES_CARD_COMMAND_TOOL_DESCRIPTION = [
  "Run one of the commands of the card open on the wearer's glasses, as if the wearer pressed its control: start, pause, add, set a number.",
  "The card keeps the rest of its state. Use it when the wearer asks the open card to do something it already does; the commands are listed in the [Open glasses card] context.",
  "No need to ask first: the wearer asking about their open card is their permission.",
  "Returns { ok, shown, error, card: { state, screen, commands } }. ok means the operation succeeded; only shown means the card is still open. Never claim it appeared when shown is false.",
].join("\n");

const editGlassesCardParametersSchema = {
  type: "object",
  properties: {

    speck: PROGRAM_CARD_SPECK_PROPERTY,
    edits: {
      type: "array",
      maxItems: PROGRAM_CARD_LIMITS.editsMax,
      description: "Find/replace edits to the open card's current source, applied in order. Each find must match exactly once.",
      items: {
        type: "object",
        required: ["find", "replace"],
        properties: {
          find: { type: "string", minLength: 1, description: "Exact text from the current source: only the lines being changed, with just enough around them to be unique." },
          replace: { type: "string", description: "What it becomes." },
        },
        additionalProperties: false,
      },
    },

    replaces: {
      type: "array",
      maxItems: CARD_CHANGE_REPLACES_MAX,
      items: { type: "integer", minimum: 1 },
    },
    notChecks: {
      type: "array",
      maxItems: CARD_CHANGE_REPLACES_MAX,
      items: { type: "integer", minimum: 1 },
    },
  },
  additionalProperties: false,
};

const EDIT_GLASSES_CARD_TOOL_DESCRIPTION = [
  "Change the code of the card open on the wearer's glasses and keep its running state: a timer keeps counting, a list keeps its items.",
  "Use it when the wearer asks the open card to look or work differently (bigger numbers, a new button, show seconds). Send small find/replace edits to the current source from the [Open glasses card] context.",
  "Every character you send costs the wearer wait time, so never repeat unchanged code: each find is only the lines that change, and fixing several spots means several small edits in one call, not one edit around a whole function.",
  "New top-level state fields take their value from init; if you change the shape of an existing field, add migrate(prev, ctx) to the card object to carry the old state over.",
  "If the new code fails to start or draw, the old card keeps running and the error comes back so you can fix the edit.",
  "No need to ask first: the wearer asking to change their open card is their permission. Never use write_glasses_card for this; it starts the card over.",
  "Returns { ok, shown, error, migrated, added, reset, card: { state, screen, commands } }. ok means the edit succeeded; only shown means the card is still open. Never claim it appeared when shown is false. If card_not_open, say the edit did not run; do not rebuild or save a duplicate card to work around it.",
  "It changes only the card open now. To change a saved card that is not open, call ask_glasses_card with savedCard (its name or id) instead: the wearer's yes opens it, then edit it.",
].join("\n");

const PROGRAM_CARD_LOOK_CLOSED_NEXT = "This chat has no open card on record. If the wearer asked why a saved card is not working, call manage_liveui_tasks with operation \"check\" and savedCard set to its name or id before you ask them to open it: it says what is not working and who can fix it with the card closed (with no fields it checks every saved card and Task).";
const PROGRAM_CARD_EDIT_CLOSED_NEXT = "If the wearer asked to change a saved card, it is not open: call ask_glasses_card now with savedCard set to its name or id and plan only the change. The wearer's yes opens it as a change; then edit it. Do not tell the wearer to open it first.";

const DRIVE_REPEATED_NEXT ="This call repeated the last call's steps. To reach a state that takes many moves (low life, a defeat, a later level), start a new Look with start: { state } set to that state instead of repeating steps.";

function driveNext(completed                                            ) {
  const left = Number.isInteger(completed.callsLeft) ? ` ${completed.callsLeft} call${completed.callsLeft === 1 ? "" : "s"} left on this copy.` : "";
  return "Continue this private copy with copyId, or Stop it. After an edit, Look again replays the complete drive plan. The whole drive counts as one of this turn's 3 Looks." + left
    + (completed.repeated ? ` ${DRIVE_REPEATED_NEXT}` : "");
}

function isPlainObject(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateCardCommandInput(input     )      {
  if (!isPlainObject(input)) return invalid("input must be an object");
  const unknown = Object.keys(input).filter((key) => key !== "id" && key !== "args" && key !== "capture");
  if (unknown.length > 0) return invalid(`unknown key(s): ${unknown.join(", ")}`);
  if (typeof input.id !== "string" || !input.id.trim()) return invalid("id must be a command id");
  if (input.args !== undefined && !isPlainObject(input.args)) return invalid("args must be an object");
  if (input.capture !== undefined && typeof input.capture !== "boolean") return invalid("capture must be true or false");
  return { ok: true, payload: { id: input.id.trim(), args: input.args ?? {}, ...(input.capture === true ? { capture: true } : {}) } };
}

const PROGRAM_CARD_EDIT_VERDICTS_RETIRED =
  "invalid_request: send no verdicts: the host judges each ask line from the Test's tagged steps. To check a line no step showed, Test once with a step whose proves names it.";

function validateCardEditInput(input     )      {
  if (!isPlainObject(input)) return invalid("input must be an object");

  const unknown = Object.keys(input).filter((key) => key !== "edits" && key !== "source" && key !== "verdicts" && key !== "asks" && key !== "speck");
  if (unknown.length > 0) return invalid(`unknown key(s): ${unknown.join(", ")}`);

  const asks = normalizeProgramCardAsks(input.asks);
  const extra = { ...(asks ? { asks } : {}) };
  const sentVerdicts = Array.isArray(input.verdicts) && input.verdicts.length > 0;

  const noOpEdits = Array.isArray(input.edits) && input.edits.length > 0 && input.edits.every((edit     ) =>
    isPlainObject(edit) && typeof edit.find === "string" && edit.find === edit.replace);
  if (noOpEdits && sentVerdicts) return { ok: false, error: PROGRAM_CARD_EDIT_VERDICTS_RETIRED };
  const hasEdits = input.edits !== undefined && !(Array.isArray(input.edits) && input.edits.length === 0);
  const hasSource = !hasEdits && input.source !== undefined && !(typeof input.source === "string" && !input.source.trim());
  if (!hasEdits && !hasSource) return sentVerdicts ? { ok: false, error: PROGRAM_CARD_EDIT_VERDICTS_RETIRED } : invalid("give edits");
  if (hasSource) {
    const source = checkText(input, "source", PROGRAM_CARD_LIMITS.sourceMax, false);
    return source.ok ? { ok: true, payload: { source: source.text, ...extra } } : source;
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) return invalid("edits must be a non-empty array");
  if (input.edits.length > PROGRAM_CARD_LIMITS.editsMax) return invalid(`at most ${PROGRAM_CARD_LIMITS.editsMax} edits`);
  for (const [i, edit] of input.edits.entries()) {
    if (!isPlainObject(edit) || typeof edit.find !== "string" || !edit.find || typeof edit.replace !== "string") {
      return invalid(`edits[${i}] needs a non-empty find and a replace string`);
    }
  }
  return { ok: true, payload: { edits: input.edits.map((e     ) => ({ find: e.find, replace: e.replace })), ...extra } };
}

const ASK_USER_FIRST_ERROR =
  "ask_user_first: nothing was sent. Call ask_glasses_card first, and write the card only on its yes.";

function invalid(message        )      {
  return { ok: false, error: `invalid_request: ${message}` };
}

function checkOptionalText(input     , field        , max        )      {
  const value = input[field];
  if (typeof value !== "string") return invalid(`${field} must be a string`);
  const text = value.trim();
  if (text.length > max) return invalid(`${field} is ${text.length} chars; max ${max}`);
  return { ok: true, text };
}

function checkText(input     , field        , max        , trim         )      {
  const value = input[field];
  if (typeof value !== "string") return invalid(`${field} must be a string`);
  const text = trim ? value.trim() : value;
  if (!text.trim()) return invalid(`${field} cannot be empty`);
  if (text.length > max) return invalid(`${field} is ${text.length} chars; max ${max}`);
  return { ok: true, text };
}

function validateProgramCardInput(input     )      {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid("input must be an object");
  }
  if (input.userAgreed !== undefined && input.userAgreed !== true) {
    return { ok: false, error: ASK_USER_FIRST_ERROR };
  }
  const allowed = new Set(Object.keys(programCardParametersSchema.properties));
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return invalid(`unknown key(s): ${unknown.join(", ")}`);
  const title = checkText(input, "title", PROGRAM_CARD_LIMITS.titleMax, true);
  if (!title.ok) return title;
  const why = input.why === undefined ? { ok: true, text: "" } : checkOptionalText(input, "why", PROGRAM_CARD_LIMITS.whyMax);
  if (!why.ok) return why;

  if (!why.text) why.text = title.text;
  const source = checkText(input, "source", PROGRAM_CARD_LIMITS.sourceMax, false);
  if (!source.ok) return source;
  const asks = normalizeProgramCardAsks(input.asks);
  if (input.asks !== undefined && !asks) return invalid("asks needs request (at most 500 chars) or at most 6 requirements (80 chars each)");

  const description = typeof input.description === "string" && input.description.trim()
    ? input.description.replace(/\s+/g, " ").trim().slice(0, PROGRAM_CARD_DESCRIPTION_MAX)
    : null;
  return {
    ok: true,
    card: { title: title.text, why: why.text, source: source.text, ...(description ? { description } : {}), ...(asks ? { asks } : {}) },
  };
}

function createPendingProgramCardMap() {
  const byRequest = new Map             ();

  function register(sessionKey        , requestId        )               {
    return new Promise((resolve) => {
      byRequest.set(requestId, { sessionKey, resolve });
    });
  }

  function resolve(requestId        , outcome     ) {
    const pending = byRequest.get(requestId);
    if (!pending) return;
    byRequest.delete(requestId);
    pending.resolve(outcome);
  }

  function drain(match                           , outcome     ) {
    const ids           = [];
    for (const [requestId, pending] of byRequest) {
      if (match(pending)) ids.push(requestId);
    }
    for (const requestId of ids) resolve(requestId, outcome);
    return ids.length;
  }

  return {
    register,
    resolve,
    drainSession: (sessionKey        , outcome     ) =>
      drain((pending) => pending.sessionKey === sessionKey, outcome),
    drainAll: (outcome     ) => drain(() => true, outcome),
  };
}

function toolResult(outcome     ) {
  return {
    ok: !!(outcome && outcome.ok === true),
    shown: !!(outcome && outcome.shown === true),

    ...(outcome?.ready === true ? { ready: true } : {}),
    error: outcome && typeof outcome.error === "string" ? outcome.error : null,
    ...(outcome?.draft ? { draft: outcome.draft } : {}),
    ...(typeof outcome?.persisted === "boolean" ? { persisted: outcome.persisted } : {}),
    ...(outcome && typeof outcome.jev === "string" ? { jev: outcome.jev } : {}),
    ...(outcome && typeof outcome.mcp === "string" ? { mcp: outcome.mcp } : {}),
    ...(outcome && typeof outcome.mcpWrites === "string" ? { mcpWrites: outcome.mcpWrites } : {}),
    ...(outcome && Array.isArray(outcome.writeUses) ? { writeUses: outcome.writeUses } : {}),
    ...(outcome && outcome.reason === "mcp_not_literal" ? { reason: outcome.reason } : {}),
    ...(outcome && typeof outcome.model === "string" ? { model: outcome.model } : {}),

    ...(outcome && typeof outcome.agentRefresh === "string" ? { agentRefresh: outcome.agentRefresh } : {}),
    ...(outcome && typeof outcome.next === "string" && outcome.next ? { next: outcome.next } : {}),
  };
}

const PROGRAM_CARD_OPEN_NOTE_NEXT =
  "The card is open on the glasses. Before you check or change it, start that reply with one short sentence telling the wearer what you will check or change.";

const PROGRAM_CARD_READY_NEXT =
  "The card is ready but not on the glasses yet: the wearer is on another screen, so \"Card ready\" waits in their chat header and opens it from there. Do not say they can see it. Tell them in one short sentence that it is ready. Look, live capture, commands and edits wait until they open it, and anything the card asks them to allow is asked then.";

const PROGRAM_CARD_READY_WAIT_NEXT =
  "Nothing ran: the card is ready but the wearer has not opened it yet (\"Card ready\" waits in their chat header). Do not say it ran or that they see it, and do not rebuild it; try again once they open it.";

const PROGRAM_CARD_CLIENT_RETURN_WAIT_MS = 30_000;

const PROGRAM_CARD_CLIENT_RETURN_RECENT_MS = 180_000;

const PROGRAM_CARD_CLIENT_RETURN_SETTLE_MS = 3_000;
const CLIENT_RETURN_POLL_MS = 250;

const PROGRAM_CARD_CLIENT_RETURN_LINK_MS = PROGRAM_CARD_CLIENT_RETURN_WAIT_MS + PROGRAM_CARD_CLIENT_RETURN_SETTLE_MS;

const PROGRAM_CARD_NO_CLIENT_NEXT =
  "No phone with glasses cards is connected, so nothing was shown or changed. Do not call the card tools again in this turn. Tell the wearer in one short line that the card needs their phone connected, and try again when they next ask.";

const NO_CLIENT_NOTHING = "Nothing was shown or changed.";

const PROGRAM_CARD_FIRST_LOOK_OPEN_WAIT_MS = 3_000;
const FIRST_LOOK_POLL_MS = 50;

const HTTP_FEED_SOURCE = /\bkind["'`]?\s*:\s*["'`]http["'`]/;

const FEEDS_SOURCE = /\bfeeds["'`]?\s*:/;

const LOCATION_FEED_SOURCE = /\bkind["'`]?\s*:\s*["'`]location["'`]/;

const PROGRAM_CARD_FRAME_DRAW_TIMEOUT_MS = 20_000;

const PROGRAM_CARD_FRAME_DONE_HOLD_MS = 180_000;

const PROGRAM_CARD_TEST_DONE_NEXT =
  "Every ask line has a verdict (tests) and the Test measured no problem, so the build shows as done. The card works: do not restyle, polish or Test it again. Reply now in one or two sentences: what the Test showed and what the wearer should check.";

const PROGRAM_CARD_FIRST_TEST_NOTE =
  "firstLook is the host's first Test of this card, already run: tests holds each ask line's verdict from the step that showed it.";

function programCardTestUncoveredNext(lines          , testsLeft        ) {
  const named = lines.map((line) => JSON.stringify(line)).join(", ");
  return testsLeft > 0
    ? `The Test measured no problem, but no step showed these ask lines: ${named}. Make ONE look_glasses_card call whose steps show them, each such step with proves set to its line word for word (and an expect for words that will be on screen); the host judges each line from its step. Do not edit and do not send verdicts.`
    : `The Test measured no problem, but no step showed these ask lines: ${named}. No Test is left this turn: reply now and name them as things the wearer should try.`;
}

const PROGRAM_CARD_OPEN_FINDINGS_SENT_MAX = 6;
const OPEN_FINDINGS_NAMED_MAX = 4;

function programCardOpenFindingsNote(open       , earlier = false) {
  const named = (Array.isArray(open) ? open : []).filter((finding     ) => typeof finding?.code === "string" && finding.code)
    .slice(0, OPEN_FINDINGS_NAMED_MAX)
    .map((finding     ) => typeof finding.message === "string" && finding.message ? `${finding.code} (${finding.message.slice(0, 140)})` : finding.code);
  if (!named.length) return "";
  const more = open.length - named.length;
  const lead = earlier ? "Still open from an earlier Test, which this Test did not go back to" : "Measured problems still open, advice-level ones included";
  return `${lead}: ${named.join("; ")}${more > 0 ? `; and ${more} more${earlier ? "" : " in report.problems"}` : ""}. Each stays open until a Test runs the steps that showed it and no longer measures it; any left when the build ends are listed for the wearer as things to look at.`;
}

function programCardTestProblemsNext(testsLeft        , open        = []) {
  const next = testsLeft > 0
    ? "Fix every measured problem and failed line (tests) in one edit_glasses_card call, then Test once more with look_glasses_card and no steps: it replays this Test, and its tagged steps judge their lines again. Do not change anything the Test did not flag, and do not send verdicts."
    : "Fix every measured problem and failed line (tests) in one edit_glasses_card call, then reply: no Test is left this turn, so name what you could not check.";
  return joinNext(next, programCardOpenFindingsNote(open));
}

const PROGRAM_CARD_FIRST_LOOK_CLEAN_UNTESTED_NEXT =
  "firstLook is this card's first Look, already run, and it measured no problem. The card works: do not restyle or polish it or Look again. Reply now.";

const PROGRAM_CARD_FRAME_DRAWING_NOTE =
  "The host is now drawing this game's frame as pixel art round its view and word boxes where they are, and wraps it round your code when it is ready (a minute or two; it appears on the glasses by itself). Do not draw a frame or move the view or the word boxes; keep fixing the game if it needs it, then finish as usual.";

const PROGRAM_CARD_FRAME_CANNOT_LEAD = "The host cannot draw this game's frame:";
const FRAME_CANNOT_REASONS = new Set(Object.keys(FRAME_CANNOT_CODES));
const PROGRAM_CARD_FRAME_CANNOT_END = "the host then draws the frame by itself.";
function programCardFrameCannotNote(reason        , view          )         {
  const fix = `and Test again if a Test is left; ${PROGRAM_CARD_FRAME_CANNOT_END}`;
  if (reason === "view_too_big") {
    return `${PROGRAM_CARD_FRAME_CANNOT_LEAD} its view is ${view[2]}x${view[3]}, and a frame fits only a view of at most 288x144 (one tile). Make the view at most 288x144 (a tall board: cells of 144 / rows, the view only as wide as the board), ${fix}`;
  }
  if (reason === "has_backdrop") {
    return `${PROGRAM_CARD_FRAME_CANNOT_LEAD} its play page draws its own backdrop (a raster surface with back: true). Take the backdrop out and keep the view and readouts on black, ${fix}`;
  }
  return `${PROGRAM_CARD_FRAME_CANNOT_LEAD} the play page's own raster surfaces use every tile. Keep the play page to the view (draw the next piece or a map inside it) and native text readouts, ${fix}`;
}

const programCardTestNotCountedNext = (testsLeft        ) =>
  `This Test could not run, so it is not counted: ${testsLeft} of the card's 3 Tests ${testsLeft === 1 ? "is" : "are"} left this turn.`;

const PROGRAM_CARD_LOOK_LIMIT_NEXT =
  "No Test is left this turn (3 per card, the host's first included): reply now. Lines without a verdict show as not tested; name them as things the wearer should try.";
const withLookLimitNext = (refusal     ) => refusal?.error === "look_limit" ? { ...refusal, next: PROGRAM_CARD_LOOK_LIMIT_NEXT } : refusal;

const PROGRAM_CARD_FIRST_LOOK_CLEAN_DONE_NEXT =
  "firstLook is this card's first Look, already run, and it measured no problem. The card works and the build shows as done: do not restyle or polish it or Look again. Reply now; another card call reopens the build.";

const PROGRAM_CARD_FIRST_LOOK_CLEAN_DONE_STUDIO_NEXT =
  "firstLook is this card's first Look, already run, and it measured no problem. The card works and the build is done: do not restyle or polish it or Look again. Reply now; another card call this turn is refused.";

const PROGRAM_CARD_BUILD_DONE_ERROR = "build_done";
const PROGRAM_CARD_BUILD_DONE_NEXT = "The build is done; say what you found in your reply.";

const PROGRAM_CARD_BUILD_DONE_KEEP_MS = 15 * 60_000;

const PROGRAM_CARD_ADVISORY_LOOK_CODES_ENV = "OCUCLAW_CARD_ADVISORY_LOOK_CODES";
const PROGRAM_CARD_ADVISORY_LOOK_CODES = Object.freeze(["press_no_change", "controls_unreached", "pages_unreached"]);
function programCardAdvisoryLookCodesOn(env      = (globalThis       ).process?.env) {
  return !/^(0|false|off|no)$/i.test(String(env?.[PROGRAM_CARD_ADVISORY_LOOK_CODES_ENV] ?? "").trim());
}
const PROGRAM_CARD_FIRST_LOOK_ADVICE_NOTE =
  "The problems it lists are advice only and do not count against it: leave them unless the wearer asked about them.";

const PROGRAM_CARD_FIRST_LOOK_PROBLEMS_NEXT =
  "firstLook is this card's first Look, already run. Fix every measured problem and failed expect in one edit_glasses_card call, then Look once more. Do not change anything the Look did not flag.";

const PROGRAM_CARD_FIRST_LOOK_FAILED_NEXT =
  "The card is open, but its first Look did not run here (firstLook.error). Test it once with look_glasses_card.";

const PROGRAM_CARD_DRIVE_FAILED_NEXT =
  "This private copy stopped. Keep only the completed measured steps, fix the reported problem, then start a new Look drive.";

const PROGRAM_CARD_DRIVE_TIMEOUT_NEXT =
  "This private copy stopped: the call ran out of its 10 s of real time. That is not a card problem, so do not edit for it. The host already runs long waits as several phone calls when they fit, so these waits were too long to run at all: every wake the card schedules during a wait costs a render. Do not wait through a long phase. Keep the completed measured steps, and start a new Look drive with start set to the state just before the moment to test (a few seconds before a phase ends), with waits of a few ticks.";

const PROGRAM_CARD_LOOK_TIMEOUT_NEXT =
  "This Look stopped: it ran out of its 10 s of real time on the phone, after the steps in report.steps. That is not a card problem, so do not edit for it. The host already runs long waits as several phone calls when they fit, so these waits were too long to run at all: every wake the card schedules during a wait costs a render. Do not wait through a long phase. Look again with start set to the state just before the moment to test (a few seconds before a phase ends), with waits of a few ticks.";
const PROGRAM_CARD_DRIVE_RESUMED_NEXT =
  "Your private copy had ended, so this call started a new copy, replayed the drive's earlier steps and then ran yours: report.steps holds them all, in order. Continue with this copyId. The new copy counts as one of this turn's 3 Looks.";

const PROGRAM_CARD_STOP_NOTHING_LIVE_NEXT =
  "No private copy by that id is live, so there was nothing to stop.";
const PROGRAM_CARD_STOP_IGNORED_NOTE =
  "Stop takes only copyId; the fields in ignored did not run.";

const PROGRAM_CARD_LOOK_CALL_BUDGET_MS = 6_000;
const PROGRAM_CARD_LOOK_AUTO_DRIVE_MAX_CALLS = 4;

const PROGRAM_CARD_LOOK_CALL_STRETCH_MS = 7_000;
const PROGRAM_CARD_LOOK_PHONE_LIMIT_MS = 10_000;

const PROGRAM_CARD_LOOK_TOO_LONG_NEXT =
  "This Look did not run: its waits would take far more than the phone's 10 s of real time, even split into several calls (estimatedMs). That is not a card problem, so do not edit for it. Every wake the card schedules during a wait costs a render. Do not wait through a long phase. Look again with start set to the state just before the moment to test (a few seconds before a phase ends), with waits of a few ticks.";
const LOOK_DEFAULT_PACE = Object.freeze({ msPerWake: 60, msPerAction: 200, wakesPerSecond: 1 });
const clampPace = (value        , low        , high        ) => Math.min(high, Math.max(low, value));

const waitSecondsOf = (step     ) => { const m = /^wait:(\d+(?:\.\d+)?|\.\d+)$/.exec(String(step?.do ?? "")); return m ? Number(m[1]) : null; };
const actionsOf = (step     ) => (waitSecondsOf(step) === null ? (step?.times ?? 1) : 0) + (step?.snap ? 2 : 0);

function programCardLookPaceScale(report     ) {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const plan = Array.isArray(report?.plan) ? report.plan : [];
  if (!Number.isFinite(report?.wallMs)) return null;
  let expected = 0;
  for (const [index, step] of steps.entries()) {
    expected += (Number.isFinite(step?.wakes) ? step.wakes : 0) * LOOK_DEFAULT_PACE.msPerWake +
      actionsOf(plan[index] ?? step) * LOOK_DEFAULT_PACE.msPerAction;
  }
  return expected >= 1000 ? clampPace(report.wallMs / expected, 1, 4) : null;
}

function programCardLookPace(report     , scale      = null) {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  let wakes = 0, waitedMs = 0;
  for (const step of steps) {
    if (!Number.isFinite(step?.wakes) || step.wakes <= 0 || !Number.isFinite(step?.elapsedMs) || step.elapsedMs <= 0) continue;
    wakes += step.wakes;
    waitedMs += step.elapsedMs;
  }
  const k = Number.isFinite(scale) ? scale : 1;
  return {
    msPerWake: Math.round(LOOK_DEFAULT_PACE.msPerWake * k), msPerAction: Math.round(LOOK_DEFAULT_PACE.msPerAction * k),
    wakesPerSecond: waitedMs >= 2000 ? clampPace(wakes / (waitedMs / 1000), 1, 20) : LOOK_DEFAULT_PACE.wakesPerSecond,
  };
}

function programCardLookStepCostMs(step     , pace     ) {

  const seconds = waitSecondsOf(step) ?? (Number.isFinite(step?.watch) ? step.watch
    : Number.isFinite(step?.every) ? step.every * (step.times ?? 1) : 0);
  return seconds * pace.wakesPerSecond * pace.msPerWake + actionsOf(step) * pace.msPerAction;
}

function programCardLookAutoDrive(plan     , pace     , maxCalls = PROGRAM_CARD_LOOK_AUTO_DRIVE_MAX_CALLS, startMs = 0) {
  if (!Array.isArray(plan) || !plan.length) return null;
  const total = plan.reduce((sum        , step     ) => sum + programCardLookStepCostMs(step, pace), 0);
  if (total + startMs <= PROGRAM_CARD_LOOK_CALL_BUDGET_MS * 1.25) return null;
  for (const budgetMs of [PROGRAM_CARD_LOOK_CALL_BUDGET_MS, PROGRAM_CARD_LOOK_CALL_STRETCH_MS]) {
    const { batches, split } = splitLookPlan(plan, pace, budgetMs, startMs);
    if (batches.length > maxCalls) continue;
    const costMs = batches.map((batch       ) => Math.round(batch.reduce((sum        , step     ) => sum + programCardLookStepCostMs(step, pace), 0)));
    return { plan, batches, split, pace, startMs, budgetMs, costMs };
  }
  return null;
}

function splitLookPlan(plan       , pace     , budget        , startMs        ) {
  const steps        = [];
  const split        = [];
  const packer = lookCallPacker(pace, startMs, budget);
  const place = (step     ) => { steps.push(step); packer.add(step); };
  const msPerSecond = pace.wakesPerSecond * pace.msPerWake;
  for (const [index, step] of plan.entries()) {
    const seconds = waitSecondsOf(step);
    if (seconds === null || msPerSecond <= 0 || programCardLookStepCostMs(step, pace) <= budget) { place(step); continue; }
    const { say, snap, expect, ...rest } = step;
    const room = Math.max(0, Math.floor(packer.roomMs() / msPerSecond));
    const first = Math.min(room, Math.floor(seconds));
    const left = seconds - first;
    const lastCost = programCardLookStepCostMs({ do: "wait:0", ...(snap ? { snap } : {}) }, pace);
    const chunks = (first > 0 ? 1 : 0) + Math.max(1, Math.ceil((left * msPerSecond + lastCost) / budget));
    const each = Math.max(1, Math.floor(left / (chunks - (first > 0 ? 1 : 0))));
    const sizes = first > 0 ? [first] : [];
    while (sizes.length < chunks - 1) sizes.push(each);
    sizes.push(+(seconds - sizes.reduce((sum, size) => sum + size, 0)).toFixed(3));
    split.push({ step: index, from: steps.length, to: steps.length + chunks - 1 });
    for (const [i, size] of sizes.entries()) {
      const last = i === chunks - 1;
      place({ ...rest, do: `wait:${size}`,
        ...(i === 0 && say ? { say } : {}), ...(last && snap ? { snap } : {}), ...(last && expect ? { expect } : {}) });
    }
  }
  return { batches: packer.done(), split };
}

function lookCallPacker(pace     , startMs = 0, budget = PROGRAM_CARD_LOOK_CALL_BUDGET_MS) {
  const batches          = [];
  let batch        = [], snaps = 0, cost = 0;
  const limit = () => budget - (batches.length ? 0 : startMs);
  return {

    roomMs: () => batch.length < 12 ? limit() - cost : 0,
    add(step     ) {
      const snap = typeof step?.snap === "string" && step.snap.length > 0 ? 1 : 0;
      const stepCost = programCardLookStepCostMs(step, pace);
      if (batch.length && (batch.length >= 12 || snap && snaps >= 2 || cost + stepCost > limit())) {
        batches.push(batch); batch = []; snaps = 0; cost = 0;
      }
      batch.push(step); snaps += snap; cost += stepCost;
    },
    done() {
      if (batch.length) batches.push(batch);
      batch = [];
      return batches;
    },
  };
}

function programCardLookBatches(plan       , pace      = LOOK_DEFAULT_PACE, startMs = 0) {
  const packer = lookCallPacker(pace, startMs);
  for (const step of plan) packer.add(step);
  return packer.done();
}

function programCardLookTooLongMs(plan     , pace     ) {
  if (!Array.isArray(plan)) return null;
  const total = plan.reduce((sum        , step     ) => sum + programCardLookStepCostMs(step, pace), 0);
  return total > PROGRAM_CARD_LOOK_AUTO_DRIVE_MAX_CALLS * PROGRAM_CARD_LOOK_PHONE_LIMIT_MS ? Math.round(total) : null;
}

function programCardLookStartMs(report     ) {
  return Number.isFinite(report?.setupMs) && report.setupMs > 0 ? Math.round(clampPace(report.setupMs, 500, 4_000)) : 2_000;
}

function programCardLookJoinReports(reports       ) {
  const joined      = { ...reports.at(-1), plan: [], steps: [], problems: [], pictures: [], phoneSamples: [], wallMs: 0, frames: 0, phoneMs: 0,
    ...(reports.some((report) => Number.isFinite(report?.setupMs)) ? { setupMs: 0 } : {}) };
  let offset = 0;
  for (const report of reports) {
    const shifted = (value     ) => Number.isInteger(value?.step) ? { ...value, step: value.step + offset } : { ...value };
    joined.plan.push(...(report.plan ?? []));
    joined.steps.push(...report.steps.map((step     ) => ({ ...step, index: step.index + offset })));
    joined.problems.push(...(report.problems ?? []).map(shifted));
    joined.pictures.push(...(report.pictures ?? []).map(shifted));
    joined.phoneSamples.push(...(report.phoneSamples ?? []));
    for (const key of ["wallMs", "frames", "phoneMs", "setupMs"]) if (key in joined) joined[key] += Number.isFinite(report[key]) ? report[key] : 0;
    offset += report.steps.length;
  }
  joined.phoneSamples = joined.phoneSamples.slice(0, 24);
  return joined;
}

const SPLIT_STEP_SUMS = ["rebuild", "texts", "tiles", "stages", "g2ms", "wakes", "elapsedMs"];

const PROGRAM_CARD_LOOK_PLAY_ON_BY_MS = 20_000;
const PLAY_TIME_RAN_OUT = /^The Look's time ran out after /;

const LOOK_CHANGE_VALUES = 6;

function programCardLookPlayLeft(steps       , report     ) {
  const asked = /^play:(\d+(?:\.\d+)?)$/.exec(String(steps?.at(-1)?.do ?? ""));
  const step = report?.ok === false ? null : report?.steps?.at(-1);
  if (!asked || !step || step.index !== steps.length - 1 || !PLAY_TIME_RAN_OUT.test(String(step.stopped ?? ""))) return null;
  const ran = Number(step.play?.seconds);
  if (!Number.isFinite(ran)) return null;
  const left = Math.floor(Number(asked[1]) - ran);
  return left >= 1 ? left : null;
}

function joinedPlayParts(previous     , step     ) {
  const shiftMs = Number.isFinite(previous.elapsedMs) ? previous.elapsedMs : (previous.play?.seconds ?? 0) * 1000;
  const a = previous.play ?? {}, b = step.play ?? {};
  const seconds = +((a.seconds ?? 0) + (b.seconds ?? 0)).toFixed(1);
  const checkpoints = [...(a.checkpoints ?? []), ...(b.checkpoints ?? []).map((point     ) =>
    ({ ...point, s: Math.round(((point.s ?? 0) * 1000 + shiftMs) / 100) / 10 }))];
  const play = { ...b, seconds, inputs: (a.inputs ?? 0) + (b.inputs ?? 0), restarts: (a.restarts ?? 0) + (b.restarts ?? 0),

    checkpoints: checkpoints.length > 16 ? [...checkpoints.slice(0, 4), ...checkpoints.slice(-12)] : checkpoints };
  const stopped = PLAY_TIME_RAN_OUT.test(String(step.stopped ?? "")) ? `The Look's time ran out after ${Math.round(seconds)} s of play`
    : step.stopped;
  const change = (x     , y     ) => {
    if (!x || !y) return x ?? (y ? { ...y, firstMs: Math.round(y.firstMs + shiftMs) } : y);
    const n = x.n + y.n;
    const values = Array.isArray(x.values) && Array.isArray(y.values) && n <= LOOK_CHANGE_VALUES ? { values: [...x.values, ...y.values] }
      : "values" in x || "last" in x || "values" in y || "last" in y ? { last: "last" in y ? y.last : y.values?.at(-1) ?? x.last ?? x.values?.at(-1) } : {};
    const { values: _values, last: _last, ...rest } = x;
    return { ...rest, n, ...values };
  };
  const ca = previous.changes, cb = step.changes;
  const changes = !ca || !cb ? (ca ?? cb) : {
    ...(ca.screen || cb.screen ? { screen: change(ca.screen, cb.screen) } : {}),
    ...(ca.state || cb.state ? { state: Object.fromEntries([...new Set([...Object.keys(ca.state ?? {}), ...Object.keys(cb.state ?? {})])]
      .map((key) => [key, change(ca.state?.[key], cb.state?.[key])])) } : {}),
  };
  return { play, stopped, ...(changes ? { changes } : {}) };
}

function programCardLookUnsplit(report     , split       , plan       ) {
  if (!Array.isArray(split) || !split.length || !Array.isArray(report?.steps)) return report;
  const owner           = [], parts           = [];
  for (let index = 0; index < plan.length; index++) {
    const entry = split.find((s     ) => s.step === index);
    parts[index] = entry ? entry.to - entry.from + 1 : 1;
    for (let i = 0; i < parts[index]; i++) owner.push(index);
  }
  const ownerOf = (index        ) => owner[index] ?? index;
  const steps        = [];
  for (const step of report.steps) {
    const index = ownerOf(step.index), previous = steps.at(-1);
    if (previous?.index !== index) { steps.push({ ...step, index, ran: 1 }); continue; }
    const playing = /^play:/.test(String(previous.do ?? ""));
    const joined      = { ...step, index, ran: previous.ran + 1, ...(previous.say ? { say: previous.say } : {}),
      do: playing ? `play:${+((previous.play?.seconds ?? 0) + (step.play?.seconds ?? 0)).toFixed(1)}`
        : `wait:${+((waitSecondsOf(previous) ?? 0) + (waitSecondsOf(step) ?? 0)).toFixed(3)}`,
      lz4: [...(previous.lz4 ?? []), ...(step.lz4 ?? [])],
      ...(playing ? joinedPlayParts(previous, step) : {}) };
    for (const key of SPLIT_STEP_SUMS) if (Number.isFinite(previous[key]) || Number.isFinite(step[key])) joined[key] = (previous[key] ?? 0) + (step[key] ?? 0);
    const heights = [previous.smallestTextHeight, step.smallestTextHeight].filter(Number.isFinite);
    if (heights.length) joined.smallestTextHeight = Math.min(...heights);
    if (joined.stopped === undefined) delete joined.stopped;
    steps[steps.length - 1] = joined;
  }
  for (const step of steps) {
    if (step.ran === parts[step.index] && plan[step.index]) step.do = plan[step.index].do;
    delete step.ran;
  }
  const mapped = (value     ) => Number.isInteger(value?.step) ? { ...value, step: ownerOf(value.step) } : value;
  const seen = new Set        ();
  const problems = (report.problems ?? []).map(mapped).filter((problem     ) => {
    const key = JSON.stringify(problem);
    return seen.has(key) ? false : (seen.add(key), true);
  });
  const original = JSON.parse(JSON.stringify(plan));
  return { ...report, plan: original, planHash: createHash("sha256").update(JSON.stringify(original), "utf8").digest("hex").slice(0, 32),
    steps, problems, pictures: (report.pictures ?? []).map(mapped) };
}

const PROGRAM_CARD_LOOK_NEXT =
  "Fix only measured problems or failed requirements, then look again. Stop when no broken problem remains and every requirement passes; fix-level problems should be fixed; advice is optional. Stop after 3 looks, the write's first Look included. Finish by naming what you tested, each ask's verdict (tests) and what changed; wearer_check means check on your glasses.";

const PROGRAM_CARD_LOOK_AUTO_DRIVE_NOTE =
  "The phone gives each call 10 s, so this Look ran as several phone calls on one private copy, and each long wait in split ran as shorter waits in a row. report.steps are numbered as the steps you sent.";
const PROGRAM_CARD_LOOK_DRIVE_SPLIT_NOTE =
  "The phone gives each call 10 s, so this drive call ran as several phone calls on the same copy (calls counts them), and each long wait in split ran as shorter waits in a row. report.steps are numbered as the steps you sent.";
const PROGRAM_CARD_LOOK_PLAY_ON_NOTE =
  "The phone gives each call 10 s, so your last play step played on in more phone calls on the same copy (playedOn counts them, and calls counts them against the drive's 8). report.steps shows it as the one step you sent, with all its play.";

const PROGRAM_CARD_LOOK_FAILED_NEXT =
  "This Look stopped on the phone before its last step: report.message says why, and report.steps holds the steps it finished. Fix what it names, then look again. If a control is missing because an edit renamed or removed it, send your own steps for the controls the card shows now: a Look without steps replays the old plan.";

function readyRefusal() {
  return { ok: false, shown: false, ready: true, error: PROGRAM_CARD_READY_NOT_SHOWN, next: PROGRAM_CARD_READY_WAIT_NEXT };
}

function programCardLookClean(ok         , report     , change = false) {
  const advisory = programCardAdvisoryLookCodesOn();
  const counted = Array.isArray(report?.problems) ? report.problems.filter((problem     ) => !programCardAdvisoryProblem(problem, advisory, change)) : null;
  return ok === true && Array.isArray(counted) && counted.length === 0 &&
    !(report.steps ?? []).some((step     ) => step?.expectOutcome === "failed");
}

function programCardAdvisoryProblem(problem     , advisory         , change = false) {
  if (!advisory || problem?.severity === "broken") return false;
  if (PROGRAM_CARD_ADVISORY_LOOK_CODES.includes(problem?.code) && problem?.severity !== "fix") return true;
  if (problem?.code === "text_on_frame" && typeof problem?.surface === "string" && problem.surface.startsWith(FRAME_SURFACE_PREFIX)) return true;
  return change && problem?.severity === "advice";
}

function programCardLookPhoneResult(result     , env      = (globalThis       ).process?.env, change = false) {
  const problems = result?.report?.problems;
  const advisory = programCardAdvisoryLookCodesOn(env);
  const isAdvice = (problem     ) => isPlainObject(problem) && programCardAdvisoryProblem(problem, advisory, change);
  if (result?.drive === true) {
    const keyOf = (problem     ) => `${problem?.code}|${typeof problem?.severity === "string" ? problem.severity : ""}`;
    const held = new Set(!Array.isArray(problems) ? [] : problems.filter((problem     ) => isPlainObject(problem) && !isAdvice(problem)).map(keyOf));
    const advice = !advisory || !Array.isArray(problems) ? [] : [...new Set(problems.filter(isAdvice).map(keyOf))].filter((key) => !held.has(key));
    return projectProgramCardLookDriveReceipt(result, advice);
  }
  if (!advisory || !Array.isArray(problems) || !problems.some(isAdvice)) return result;
  return { ...result, report: { ...result.report, problems: problems.map((problem     ) => isAdvice(problem) ? { ...problem, advice: true } : problem) } };
}

function joinNext(...parts       ) {
  return parts.filter((part) => typeof part === "string" && part).join(" ");
}

function jevCardOf(value     ) {
  return isPlainObject(value) && typeof value.key === "string" && value.key && Array.isArray(value.uses) && value.uses.length
    ? { key: value.key, name: typeof value.name === "string" ? value.name : "", uses: value.uses }
    : null;
}

function agentRefreshCardOf(value     ) {
  return isPlainObject(value) && typeof value.key === "string" && value.key
    ? { key: value.key, name: typeof value.name === "string" ? value.name.slice(0, 80) : "" }
    : null;
}

function emitProgramCardDebug(deps     , event        , severity        , data     , sessionKey        ) {
  if (!deps || typeof deps.emitDebug !== "function") return;
  try {
    deps.emitDebug(event, severity, data || {}, { sessionKey });
  } catch {

  }
}

function createProgramCardToolHandler(deps     ) {
  const pending = createPendingProgramCardMap();
  const lookHistory = createProgramCardLookHistory({ keyOf: deps?.sessionKeyOf });
  const newRequestId               =
    deps && typeof deps.newRequestId === "function"
      ? deps.newRequestId
      : () => `card-${globalThis.crypto.randomUUID()}`;
  const timeoutMs =
    deps && Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : DEFAULT_PROGRAM_CARD_TIMEOUT_MS;
  const setTimeoutFn =
    deps && typeof deps.setTimeout === "function" ? deps.setTimeout : setTimeout;
  const clearTimeoutFn =
    deps && typeof deps.clearTimeout === "function" ? deps.clearTimeout : clearTimeout;
  const driveController = createProgramCardLookDriveController({
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    onRelease: (release     ) => sendDriveRelease(release),
  });

  const writtenPlans = new Map                  ();
  const planKeyOf = (sessionKey        ) => typeof deps?.sessionKeyOf === "function" ? deps.sessionKeyOf(sessionKey) : sessionKey;

  const liveDecls = new Map
                                                                                                                                                                               ();

  const liveDeclOf = (sessionKey        , cardId                           ) => {
    const decl = liveDecls.get(planKeyOf(sessionKey));
    return decl && cardId && (!decl.cardId || decl.cardId === cardId) ? decl : null;
  };

  const keptRefusals = new Map                                               ();

  const wordsOnlyTests = new Set        ();
  const nowMs = () => typeof deps?.now === "function" ? deps.now() : Date.now();

  const knownPictureFiles = new Map                             ();
  async function embedPictureFiles(sessionKey        , texts          , recall = false) {
    const key = planKeyOf(sessionKey);
    let known = knownPictureFiles.get(key);
    if (!known) {
      known = new Map();
      knownPictureFiles.set(key, known);
      while (knownPictureFiles.size > 32) knownPictureFiles.delete(knownPictureFiles.keys().next().value          );
    }
    const out = await embedProgramCardPictureFiles(texts,
      () => typeof deps?.pictureFileScope === "function" ? deps.pictureFileScope(sessionKey) : null,
      typeof deps?.readPictureFile === "function" ? deps.readPictureFile : undefined, { known, recall });
    if (out.ok && out.files.length) {
      emitProgramCardDebug(deps, "program_card_picture_files", "debug",
        { files: out.files.map(f => ({ bytes: f.bytes, width: f.width, height: f.height })) }, sessionKey);
    }
    if (!out.ok) return out;
    const tooLong = out.texts.find(text => typeof text === "string" && text.length > PROGRAM_CARD_LIMITS.sourceMax);
    if (tooLong !== undefined) {
      return { ok: false         , error: `invalid_request: with its picture files the code is ${tooLong.length} chars; max ${PROGRAM_CARD_LIMITS.sourceMax}` };
    }
    return out;
  }

  const gameCode = new Map                                                                                                  ();
  function noteGameCode(sessionKey        , source               , about                                                                               = {}) {
    const key = planKeyOf(sessionKey), was = gameCode.get(key);
    gameCode.delete(key);
    if (typeof source !== "string") return;
    gameCode.set(key, { source, title: about.title ?? was?.title ?? "", request: about.request ?? was?.request ?? "", plan: about.plan ?? was?.plan ?? [],
      game: about.game !== undefined ? about.game : was?.game ?? null });
    while (gameCode.size > 64) gameCode.delete(gameCode.keys().next().value          );
  }

  function otherCardTitle(kept         , open         ) {
    const a = typeof kept === "string" ? kept.trim().toLowerCase() : "", b = typeof open === "string" ? open.trim().toLowerCase() : "";
    return !!a && !!b && !a.startsWith(b) && !b.startsWith(a);
  }

  function frameGameOf(sessionKey        , game                                                    ) {
    return { title: game.title || openCard(sessionKey)?.title || "", plan: game.plan.length ? game.plan : writtenPlans.get(planKeyOf(sessionKey)) ?? [], request: game.request };
  }
  function frameComplete() {
    try {
      const complete = deps?.frameComplete?.();
      return typeof complete === "function" ? complete : null;
    } catch { return null; }
  }

  const codeChanges = new Map                          ();
  function oneAtATime   (sessionKey        , run                  )             {
    const key = planKeyOf(sessionKey), before = codeChanges.get(key);

    const next = before ? before.then(run, run) : run();
    const tail = next.then(() => {}, () => {});
    codeChanges.set(key, tail);
    void tail.then(() => { if (codeChanges.get(key) === tail) codeChanges.delete(key); });
    return next;
  }
  const frameLane = createProgramCardFrameLane({
    complete: (params     ) => {
      const complete = frameComplete();
      if (!complete) throw new Error("no_model_call");
      return complete(params);
    },
    draw: async (sessionKey        , code        ) => {
      const outcome      = await roundTrip(sessionKey, { title: "", source: "", why: "", op: "frame_draw", payload: { code } },
        PROGRAM_CARD_FRAME_DRAW_TIMEOUT_MS);
      if (!outcome?.ok) return { ok: false         , error: String(outcome?.error ?? "frame_sandbox").slice(0, 400) };
      const result = outcome.result ?? {};
      const bytes = (field        ) => (typeof result[field] === "string" ? new Uint8Array((globalThis       ).Buffer.from(result[field], "base64")) : null);

      const screen = bytes("screen");
      if (screen && screen.length === FRAME_SCREEN_CELLS) return { ok: true         , screen, out: result.out };
      const grid = bytes("grid");
      if (grid && grid.length === FRAME_GRID_CELLS) return { ok: true         , screen: frameScreenFromGrid(grid), out: result.out };
      return { ok: false         , error: "frame_sandbox: the phone sent no screen" };
    },
    wire: (job          , frame            ) => oneAtATime(job.sessionKey, async () => {
      const card = openCard(job.sessionKey);
      const game = gameCode.get(planKeyOf(job.sessionKey));
      if (!card?.cardId || card.cardId !== job.cardId) return { ok: false, error: "card_changed" };
      if (!game) return { ok: false, error: "code_unknown" };

      const source = wrapProgramCardFrame(game.source, { png: frame.png, art: frame.art, place: frame.place,
        brief: { layout: job.layout, game: job.game } });
      if (source.length > PROGRAM_CARD_LIMITS.sourceMax) return { ok: false, error: `too_big: ${source.length} chars` };
      const outcome      = await roundTrip(job.sessionKey, { title: "", source: "", why: "", op: "edit", payload: { source } }, timeoutMs);
      if (!outcome?.ok) return { ok: false, error: String(outcome?.error ?? "refused").slice(0, 200) };
      noteGameCode(job.sessionKey, source);
      driveController.edited(job.sessionKey);
      return { ok: true };
    }),

    idea: () => deps?.hasFrameIdeaClient?.() === true,
    onIdea: (job          , idea        ) => deps?.noteFrameIdea?.(job.sessionKey, idea),
    debug: (event        , severity        , data     , sessionKey        ) => emitProgramCardDebug(deps, event, severity, data, sessionKey),
  });

  const frameNoted = new Set        ();

  function frameNote(sessionKey        , cardId        )         {
    const noted = `${planKeyOf(sessionKey)}\n${cardId}`;
    if (frameLane.status(sessionKey, cardId)?.status !== "drawing" || frameNoted.has(noted)) return "";
    frameNoted.add(noted);
    if (frameNoted.size > 64) frameNoted.delete(frameNoted.values().next().value          );
    return PROGRAM_CARD_FRAME_DRAWING_NOTE;
  }

  function startFrame(sessionKey        , report     , from                           = "report")         {
    const layout = programCardFrameLayout(report?.frameLayout);
    const card = openCard(sessionKey);
    if (!card?.cardId) return "";
    if (!layout) return from === "report" ? frameNote(sessionKey, card.cardId) : "";
    const game = gameCode.get(planKeyOf(sessionKey));
    if (!frameComplete() || deps?.hasFrameDrawClient?.() !== true || !game) {
      emitProgramCardDebug(deps, "program_card_frame_lane", "debug", { ok: false, from,
        skipped: !game ? "code_unknown" : !frameComplete() ? "no_model_call" : "no_frame_draw_client" }, sessionKey);
      return "";
    }

    if (game.game === false && !isFrameWrapped(game.source)) {
      emitProgramCardDebug(deps, "program_card_frame_lane", "debug", { ok: false, from, skipped: "not_a_game" }, sessionKey);
      return "";
    }

    if (layout.browse === true && (game.game !== true || looksLikeGame(game.source))) return "";
    const was = frameLane.status(sessionKey, card.cardId);
    const frameGame = frameGameOf(sessionKey, game);

    if (!isFrameWrapped(game.source)) {
      try { deps?.noteFrameBrief?.(game.source, { layout, game: frameGame }); } catch {  }
    }

    let detail                     = null;
    try { detail = frameDetailOf(deps?.frameDetail?.()); } catch { detail = null; }
    const started = frameLane.start({ sessionKey, cardId: card.cardId, layout, from, game: frameGame, ...(detail ? { detail } : {}) });

    if (started.status === "drawing" && was?.status !== "drawing") {
      deps?.holdBuildDone?.(sessionKey, frameLane.settled(sessionKey), PROGRAM_CARD_FRAME_DONE_HOLD_MS);
    }

    if (started.status === "skipped" && from === "report" && FRAME_CANNOT_REASONS.has(started.reason ?? "")) {
      const noted = `${planKeyOf(sessionKey)}\n${card.cardId}\n${started.reason}\n${layout.view.join(",")}`;
      if (frameNoted.has(noted)) return "";
      frameNoted.add(noted);
      if (frameNoted.size > 64) frameNoted.delete(frameNoted.values().next().value          );
      return programCardFrameCannotNote(started.reason          , layout.view);
    }
    return from === "report" ? frameNote(sessionKey, card.cardId) : "";
  }

  function prepareFrameIdea(sessionKey        , game                                                    )          {
    try {
      if (!frameComplete() || deps?.hasFrameDrawClient?.() !== true) return false;
      return frameLane.prepareIdea({ sessionKey, cardId: openCard(sessionKey)?.cardId ?? "", game });
    } catch { return false;  }
  }

  function prepareWrittenFrameIdea(sessionKey        , source     ) {
    if (!looksLikeGame(source)) return;
    const game = gameCode.get(planKeyOf(sessionKey));
    if (game && game.game !== false) prepareFrameIdea(sessionKey, frameGameOf(sessionKey, game));
  }

  function startFrameAtPlayScreen(sessionKey        , frameLayout     ) {
    try {
      startFrame(sessionKey, { frameLayout }, "start_press");
    } catch (err     ) {
      emitProgramCardDebug(deps, "program_card_frame_lane", "warn", { ok: false, from: "start_press",
        error: String(err?.message ?? err).slice(0, 200) }, sessionKey);
    }
  }

  function lookNextWithFrame(sessionKey        , report     , stoppedNext               ) {
    return joinNext(stoppedNext ?? PROGRAM_CARD_LOOK_NEXT, startFrame(sessionKey, report));
  }
  function frameTail(sessionKey        , report     , plain = "") {
    return joinNext(plain, startFrame(sessionKey, report));
  }

  function isTaskCardBuild(sessionKey        )          {
    try {
      return typeof deps?.taskFor === "function" && !!deps.taskFor(sessionKey);
    } catch (_) {
      return false;
    }
  }
  function keepRefusal(sessionKey        , params     , ctx     ) {
    const key = planKeyOf(sessionKey);
    keptRefusals.delete(key);
    keptRefusals.set(key, { params, ctx: { ...(ctx?.imageModel ? { imageModel: ctx.imageModel } : {}), ...(Array.isArray(ctx?.plan) ? { plan: ctx.plan } : {}),
      ...(typeof ctx?.game === "boolean" ? { game: ctx.game } : {}) }, at: nowMs() });
    if (keptRefusals.size > 64) keptRefusals.delete(keptRefusals.keys().next().value          );
    emitProgramCardDebug(deps, "program_card_refusal_kept", "debug", { sourceLength: typeof params?.source === "string" ? params.source.length : 0 }, sessionKey);
  }
  function keptRefusal(sessionKey        ) {
    const key = planKeyOf(sessionKey), kept = keptRefusals.get(key);
    if (kept && nowMs() - kept.at > PROGRAM_CARD_KEPT_REFUSAL_MS) keptRefusals.delete(key);
    return keptRefusals.get(key) ?? null;
  }

  const isCodeRefusal = (outcome     ) => !!outcome && outcome.ok !== true && outcome.persisted !== true &&
    typeof outcome.error === "string" && /\s/.test(outcome.error.trim());

  function openCardNote(shown         ) {
    if (!shown || !deps || typeof deps.notesOn !== "function") return "";
    try {
      return deps.notesOn() === true ? PROGRAM_CARD_OPEN_NOTE_NEXT : "";
    } catch {
      return "";
    }
  }

  const phoneCall = new AsyncLocalStorage                                    ();

  function hasCapableClient() {
    if (!deps || typeof deps.hasCapableClient !== "function") return false;
    try {
      return deps.hasCapableClient() === true;
    } catch {
      return false;
    }
  }

  function clientAwayMs()                {
    try {
      const away = typeof deps?.clientAwayMs === "function" ? deps.clientAwayMs() : null;
      return Number.isFinite(away) && away >= 0 ? away : null;
    } catch {
      return null;
    }
  }
  const clientReturnWaitMs = Number.isFinite(deps?.clientReturnWaitMs) ? deps.clientReturnWaitMs : PROGRAM_CARD_CLIENT_RETURN_WAIT_MS;
  const sleep = (ms        ) => new Promise      ((resolve) => setTimeoutFn(() => resolve(), ms));

  const clientWaits = new Map                                 ();
  function endClientWaits(sessionKey               ) {
    for (const [key, waits] of clientWaits) {
      if (sessionKey !== null && key !== planKeyOf(sessionKey)) continue;
      for (const wait of waits) wait.ended = true;
    }
  }

  async function capableClientBack(sessionKey        , op        )                   {
    if (hasCapableClient()) return true;
    const awayMs = clientAwayMs();
    if (awayMs === null || awayMs > PROGRAM_CARD_CLIENT_RETURN_RECENT_MS || !(clientReturnWaitMs > 0)) return false;
    emitProgramCardDebug(deps, "program_card_client_wait", "info", { op, awayMs, waitMs: clientReturnWaitMs }, sessionKey);
    const wait = { ended: false };
    const at = planKeyOf(sessionKey);
    const waits = clientWaits.get(at) ?? new Set                    ();
    clientWaits.set(at, waits);
    waits.add(wait);
    try {
      let waitedMs = 0;
      while (!wait.ended && !hasCapableClient()) {
        if (waitedMs >= clientReturnWaitMs) {
          emitProgramCardDebug(deps, "program_card_client_wait_expired", "warn", { op, waitedMs }, sessionKey);
          return false;
        }
        await sleep(CLIENT_RETURN_POLL_MS);
        waitedMs += CLIENT_RETURN_POLL_MS;
      }
      let settledMs = 0;
      if (typeof deps?.supportsDrafts === "function") {
        while (!wait.ended && deps.supportsDrafts(sessionKey) !== true && settledMs < PROGRAM_CARD_CLIENT_RETURN_SETTLE_MS) {
          await sleep(CLIENT_RETURN_POLL_MS);
          settledMs += CLIENT_RETURN_POLL_MS;
        }
      }
      if (wait.ended) {
        emitProgramCardDebug(deps, "program_card_client_wait_ended", "info", { op, waitedMs }, sessionKey);
        return false;
      }
      emitProgramCardDebug(deps, "program_card_client_back", "info", { op, waitedMs, settledMs }, sessionKey);
      return hasCapableClient();
    } finally {
      waits.delete(wait);
      if (waits.size === 0) clientWaits.delete(at);
    }
  }
  const noClient = () => ({ ok: false, error: "no_client", next: PROGRAM_CARD_NO_CLIENT_NEXT });

  function openCard(sessionKey        ) {
    return typeof deps?.getOpenCard === "function" ? deps.getOpenCard(sessionKey) : null;
  }

  function cardReady(sessionKey        ) {
    try { return typeof deps?.isCardReady === "function" && deps.isCardReady(sessionKey) === true; } catch { return false; }
  }

  function markCardReady(sessionKey        , held         ) {
    try { deps?.markCardReady?.(sessionKey, held); } catch {  }
  }

  function hasDriveLookClient() {
    return typeof deps?.hasDriveLookClient === "function" && deps.hasDriveLookClient() === true;
  }

  function sendDriveRelease(release     ) {
    if (!release?.stopRequest) return false;
    try {
      deps.relay.sendProgramCardRequest({ sessionKey: release.sessionKey, requestId: newRequestId(), title: "", source: "", why: "",
        op: "look", payload: release.stopRequest });
      return true;
    } catch { return false; }
  }

  function openFindings(sessionKey        , cardId        )        {
    const advisory = programCardAdvisoryLookCodesOn();
    const change = changing(sessionKey);
    return lookHistory.openFindings(sessionKey, cardId).filter((finding     ) => !programCardAdvisoryProblem(finding, advisory, change));
  }

  function deliverLookResult(sessionKey        , requestId        , cardId        , result     ) {
    if (typeof deps?.relay?.sendProgramCardLookResult === "function") {
      const phoneResult = programCardLookPhoneResult(result, undefined, changing(sessionKey));

      const done = result?.verdictsOnly === true ? { verdictsOnly: true } : {};
      const wordsOnly = wordsOnlyTests.has(sessionKey) ? { modelReadsPictures: false } : {};

      const open = { open: openFindings(sessionKey, cardId).slice(0, PROGRAM_CARD_OPEN_FINDINGS_SENT_MAX)
        .map(({ code, message, step, severity }     ) => ({ code, message, ...(Number.isInteger(step) ? { step } : {}), ...(severity ? { severity } : {}) })) };
      try { return deps.relay.sendProgramCardLookResult({ ...phoneResult, ...done, ...wordsOnly, ...open, sessionKey, requestId, cardId }) !== false; } catch {  }
    }
    return false;
  }

  function hasLiveCaptureClient() {
    return typeof deps?.hasLiveCaptureClient === "function" && deps.hasLiveCaptureClient() === true;
  }

  function captureAnswer(outcome     , cardId        , ctx     , live = false) {
    const body = isPlainObject(outcome?.result) ? outcome.result : {};
    if (!body.capture && outcome?.ok !== true) return { ...body, ok: false, error: outcome?.error || body.error || "capture_failed",
      picturesDelivered: false, picturesReason: "pictures not delivered: the capture did not finish" };
    if (body.cardId && body.cardId !== cardId) return { ok: false, error: "card_changed", picturesDelivered: false };
    const checked = validateProgramCardCapture(body.capture, cardId);
    if (!checked.ok) return { ...checked, picturesDelivered: false };
    const model = ctx?.imageModel ?? { host: "unknown", model: "unknown", input: [] };
    const ok = outcome?.ok === true && body.ok !== false && checked.capture.status !== "card_changed";
    const { images, ...delivery } = lookToolPictures(checked.capture, ok ? model : { ...model, input: [] });
    if (checked.capture.status === "card_changed") delivery.picturesReason = "pictures not delivered: the card changed";
    if (!images.length && model.input?.includes("image") && checked.capture.picturesReason) delivery.picturesReason = checked.capture.picturesReason;
    const capture = { ...checked.capture, pictures: checked.capture.pictures.map(({ png, ...picture }     ) => picture) };
    const result = { ...body, ok, error: ok ? null : outcome?.error || body.error || "card_changed",
      ...(live ? { live: true, cardId } : {}), capture, ...delivery };
    if (typeof deps?.admitLookResult === "function" && deps.admitLookResult({ ...result, images }) !== true) {
      return { ok: false, error: "look_payload_too_large", picturesDelivered: false,
        picturesReason: "pictures not delivered: the capture exceeds the host transport budget" };
    }
    emitProgramCardDebug(deps, "program_card_capture_images", "debug", { host: model.host || "unknown", model: model.model || "unknown",
      pixelsSent: images.length > 0, status: capture.status, requestedSeq: capture.requestedSeq, currentSeq: capture.currentSeq }, ctx?.sessionKey);
    return { ...result, images };
  }

  const paceScales = new Map                ();
  const paceKey = (sessionKey        , cardId        ) => `${sessionKey}\u0000${cardId}`;
  const notePace = (sessionKey        , cardId        , report     ) => {
    const scale = programCardLookPaceScale(report);
    if (scale === null) return;
    const key = paceKey(sessionKey, cardId);
    paceScales.delete(key);
    paceScales.set(key, scale);
    if (paceScales.size > 64) paceScales.delete(paceScales.keys().next().value          );
  };
  const lookPaceOf = (sessionKey        , cardId        ) =>
    programCardLookPace(lookHistory.snapshot(sessionKey, cardId)?.report, paceScales.get(paceKey(sessionKey, cardId)) ?? null);
  const lookStartOf = (sessionKey        , cardId        ) => programCardLookStartMs(lookHistory.snapshot(sessionKey, cardId)?.report);

  const refuseTooLong = (sessionKey        , plan     , pace     ) => {
    const estimatedMs = programCardLookTooLongMs(plan, pace);
    if (estimatedMs === null) return null;
    emitProgramCardDebug(deps, "program_card_look_too_long", "debug", { estimatedMs, pace }, sessionKey);
    return { ok: false, error: "look_too_long", estimatedMs, next: PROGRAM_CARD_LOOK_TOO_LONG_NEXT };
  };

  const sourceDigest = (source     ) => typeof source === "string"
    ? createHash("sha256").update(source, "utf8").digest("hex").slice(0, 32) : null;
  const plainProblems = (report     ) => [...new Set((report?.problems ?? []).map((problem     ) =>
    String(problem?.message ?? problem?.code ?? "Look problem").slice(0, 300)))].slice(0, 32);
  const plainStateSummary = (state     ) => {
    const scalar = (value     ) => value === null || ["string", "number", "boolean"].includes(typeof value);
    let text;
    if (state && typeof state === "object" && !Array.isArray(state)) {
      const fields = Object.entries(state).filter(([, value]) => scalar(value)).slice(0, 8);
      text = fields.length ? fields.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("; ") : JSON.stringify(state);
    } else text = `state: ${JSON.stringify(state ?? null)}`;
    return (text || "state: unavailable").slice(0, 500);
  };

  const testNotCounted = (sessionKey        , cardId        ) => lookHistory.notCounted(sessionKey, cardId)
    ? { notCounted: true, next: programCardTestNotCountedNext(lookHistory.testsLeft(sessionKey, cardId)) } : {};

  async function driveBatch(sessionKey        , card     , payload     , ctx     ) {
    const starting = payload.drive === true;
    const historyReservation = starting
      ? lookHistory.reserveDrive(sessionKey, card.cardId, payload)
      : lookHistory.continueDrive(sessionKey, card.cardId, payload);
    if (!historyReservation.ok) return withLookLimitNext(historyReservation);
    const reserved      = driveController.reserve(sessionKey, { ...historyReservation.payload, cardId: card.cardId }, true);
    if (!reserved.ok) return reserved;
    const abandon = (reason        , rawCopyId      ) => {
      const known = driveController.snapshot(sessionKey)?.copyId;
      driveController.fail(reserved.reservation, reason);
      if (!known && typeof rawCopyId === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCopyId)) {
        sendDriveRelease({ sessionKey, stopRequest: { drive: true, copyId: rawCopyId, stop: true, cardId: card.cardId } });
      }
    };
    const outcome = await roundTrip(sessionKey, { title: "", source: "", why: "", op: "look", payload: reserved.payload }, reserved.timeoutMs);
    if (!isPlainObject(outcome?.result?.drive) || !isPlainObject(outcome?.result?.report)) {
      abandon(outcome?.error || "drive_failed", outcome?.result?.drive?.copyId);

      return { ok: false, error: outcome?.error || "drive_failed", failedCopy: true, ...(starting ? testNotCounted(sessionKey, card.cardId) : {}) };
    }
    const failedOutcome = outcome.ok !== true || outcome.result.report.ok === false;
    if (outcome.result.cardId !== card.cardId) {
      abandon("card_changed", outcome.result.drive.copyId);
      return { ok: false, error: "card_changed", failedCopy: true };
    }
    const checked = validateLookReport(outcome.result.report, { partial: failedOutcome });
    if (!checked.ok || !Array.isArray(checked.report.plan) ||

      JSON.stringify(withoutPlayHints(checked.report.plan)) !== JSON.stringify(withoutPlayHints(reserved.reservation.steps))) {
      abandon(checked.error || "invalid_drive_report_plan", outcome.result.drive.copyId);
      return { ok: false, error: checked.error || "invalid_drive_report_plan", failedCopy: true };
    }
    const expectedDigest = sourceDigest(card.source);
    if (expectedDigest && checked.report.digest !== expectedDigest) {
      abandon("drive_identity_changed", outcome.result.drive.copyId);
      return { ok: false, error: "drive_identity_changed", failedCopy: true };
    }
    const drive = outcome.result.drive;
    if (failedOutcome) {
      const active = driveController.snapshot(sessionKey);
      if (!active) {
        abandon("drive_call_expired", drive.copyId);
        return { ok: false, error: "drive_call_expired", failedCopy: true };
      }
      const retainedSteps = active?.replayPlan?.steps ?? [];
      const retainedHash = createHash("sha256").update(JSON.stringify(retainedSteps), "utf8").digest("hex").slice(0, 32);
      const partialDrive      = validateProgramCardLookDriveResult({ ...drive, pictures: checked.report.pictures,
        digest: checked.report.digest, t0: checked.report.t0 }, { partial: true, copyId: active?.copyId,
        steps: reserved.reservation.steps, planHash: retainedHash,
        ...(active.digest ? { digest: active.digest } : {}), ...(active.t0 !== null ? { t0: active.t0 } : {}) });
      if (!partialDrive.ok || (active.clockMs !== null && drive.clockMs < active.clockMs)) {
        const error = partialDrive.error || "drive_clock_rewound";
        abandon(error, drive.copyId);
        return { ok: false, error, failedCopy: true };
      }
      const model = ctx?.imageModel ?? { model: "unknown", input: [] };
      const { images, ...pictures } = lookToolPictures(checked.report, { ...model, input: [] });
      const error = outcome.error || checked.report.error || "look_failed";
      const receiptStatus = { ok: false, error, failedCopy: true };
      const history      = lookHistory.completeDriveFailure(sessionKey, card.cardId, checked.report,
        { ...pictures, ...receiptStatus }, outcome.requestId);
      if (!history.ok) {
        abandon(history.error, drive.copyId);
        return { ...history, failedCopy: true };
      }
      const { report: aggregateReport, ok: _historyOk, ...historyResult } = history;
      const replayStart = active.replayPlan?.start ?? reserved.payload.start;
      const replayPlan = { version: 1, ...(replayStart !== undefined ? { start: replayStart } : {}),
        steps: aggregateReport.plan, planHash: aggregateReport.planHash };
      const result = { ...receiptStatus, drive: true, cardId: card.cardId,
        copyId: active.copyId, calls: active.calls, clockMs: drive.clockMs, screenWords: drive.screenWords,
        stateSummary: drive.stateSummary, problemText: drive.problemText, replayPlan,
        report: lookReportWithoutPixels(checked.report), ...historyResult, ...pictures,
        next: joinNext(error === "look_timeout" ? PROGRAM_CARD_DRIVE_TIMEOUT_NEXT : PROGRAM_CARD_DRIVE_FAILED_NEXT,
          historyResult.notCounted ? programCardTestNotCountedNext(lookHistory.testsLeft(sessionKey, card.cardId)) : null) };
      if (typeof deps?.admitLookResult === "function" && deps.admitLookResult({ ...result, aggregateReport, images }) !== true) {
        const refusal = { ok: false, error: "look_payload_too_large", failedCopy: true,
          picturesDelivered: false, picturesReason: "pictures not delivered: the drive result exceeds the host transport budget" };
        lookHistory.recordDelivery(sessionKey, card.cardId, refusal);
        deliverLookResult(sessionKey, outcome.requestId, card.cardId, { ...result, report: aggregateReport, ...refusal });
        abandon(refusal.error, drive.copyId);
        return refusal;
      }
      deliverLookResult(sessionKey, outcome.requestId, card.cardId, { ...result, report: aggregateReport });
      abandon(error, drive.copyId);
      emitProgramCardDebug(deps, "program_card_look_drive_failed", "warn", { host: model.host || "unknown",
        model: model.model || "unknown", completedSteps: checked.report.steps.length, error }, sessionKey);
      return { ...result, images, imageReport: checked.report, aggregateReport };
    }
    const lastScreen = checked.report.steps.at(-1)?.screen ?? [];
    if (JSON.stringify(drive.screenWords) !== JSON.stringify(lastScreen) ||
      drive.stateSummary !== plainStateSummary(checked.report.steps.at(-1)?.state) ||
      JSON.stringify(drive.problemText) !== JSON.stringify(plainProblems(checked.report))) {
      abandon("invalid_drive_summary", outcome.result.drive.copyId);
      return { ok: false, error: "invalid_drive_summary", failedCopy: true };
    }
    const knownBeforeComplete = driveController.snapshot(sessionKey)?.copyId;
    const completed      = driveController.complete(reserved.reservation, { ...drive, pictures: checked.report.pictures,
      digest: checked.report.digest, t0: checked.report.t0 });
    if (!completed.ok) {
      if (!knownBeforeComplete && typeof drive.copyId === "string") sendDriveRelease({ sessionKey,
        stopRequest: { drive: true, copyId: drive.copyId, stop: true, cardId: card.cardId } });
      return { ...completed, failedCopy: true };
    }
    if (!starting) notePace(sessionKey, card.cardId, checked.report);
    const model = ctx?.imageModel ?? { model: "unknown", input: [] };
    const { images, ...pictures } = lookToolPictures(checked.report, model);
    const receiptStatus = { ok: true, error: null, failedCopy: false };
    const history      = lookHistory.completeDrive(sessionKey, card.cardId, checked.report, completed.replayPlan,
      { ...pictures, ...receiptStatus }, outcome.requestId);
    if (!history.ok) {
      driveController.disconnect(sessionKey);
      return { ...history, failedCopy: true };
    }
    const { report: aggregateReport, ok: _historyOk, ...historyResult } = history;
    const result = { ...receiptStatus, drive: true, cardId: card.cardId,
      copyId: completed.copyId, calls: completed.calls, clockMs: completed.clockMs,
      screenWords: completed.screenWords, stateSummary: completed.stateSummary, problemText: completed.problemText,
      replayPlan: completed.replayPlan, report: lookReportWithoutPixels(checked.report), ...historyResult, ...pictures,
      next: frameTail(sessionKey, aggregateReport, driveNext(completed)) };
    if (typeof deps?.admitLookResult === "function" && deps.admitLookResult({ ...result, aggregateReport, images }) !== true) {
      const delivery = { picturesDelivered: false, picturesReason: "pictures not delivered: the drive result exceeds the host transport budget" };
      const refusal = { ok: false, error: "look_payload_too_large", failedCopy: true, ...delivery };
      lookHistory.recordDelivery(sessionKey, card.cardId, refusal);
      deliverLookResult(sessionKey, outcome.requestId, card.cardId, { ...result, report: aggregateReport, ...refusal });
      driveController.disconnect(sessionKey);
      return refusal;
    }
    deliverLookResult(sessionKey, outcome.requestId, card.cardId, { ...result, report: aggregateReport });
    emitProgramCardDebug(deps, "program_card_look_drive_images", "debug", { host: model.host || "unknown", model: model.model || "unknown",
      pixelsSent: images.length > 0, pictures: images.length, inputSource: model.inputSource ?? null, calls: completed.calls }, sessionKey);
    return { ...result, images, imageReport: checked.report, aggregateReport };
  }

  async function releaseDrive(sessionKey        , active     ) {
    const payload = { drive: true, copyId: active.copyId, stop: true, ...(active.cardId ? { cardId: active.cardId } : {}) };
    const outcome = await roundTrip(sessionKey, { title: "", source: "", why: "", op: "look", payload }, 10_000);
    const acknowledged = outcome?.error === "look_drive_not_found" ||
      outcome?.ok === true && outcome?.result?.copyId === active.copyId && outcome?.result?.stopped === true;
    const released      = driveController.stop(sessionKey, active.copyId, acknowledged !== true);
    return { acknowledged, error: acknowledged ? null : outcome?.error || "drive_stop_failed", released };
  }

  async function stopDrive(sessionKey        , input     , ignored           ) {
    const active = driveController.snapshot(sessionKey);
    const extras = { ...(ignored?.length ? { ignored, ignoredNote: PROGRAM_CARD_STOP_IGNORED_NOTE } : {}) };
    if (!active || input.copyId !== undefined && input.copyId !== active.copyId) {
      return { ok: true, error: null, stopped: false, copyId: input.copyId ?? null, next: PROGRAM_CARD_STOP_NOTHING_LIVE_NEXT,
        ...(active ? { liveCopyId: active.copyId } : {}), ...extras };
    }
    const { acknowledged, error, released } = await releaseDrive(sessionKey, active);

    const tail = active.cardId ? frameTail(sessionKey, lookHistory.snapshot(sessionKey, active.cardId)?.report) : "";
    return { ok: acknowledged, error, stopped: acknowledged,
      copyId: active.copyId, calls: released.calls, pictures: released.pictures, clockMs: released.clockMs, replayPlan: released.replayPlan, ...extras,
      ...(tail ? { next: tail } : {}) };
  }

  async function autoDrive(sessionKey        , card     , payload     , auto     , ctx     ) {
    const { steps: _steps, ...rest } = payload;
    let copy                = null, latest      = null;
    const images        = [], wallMs        = [];
    for (const [index, steps] of auto.batches.entries()) {
      latest = await driveBatch(sessionKey, card, index === 0 ? { ...rest, drive: true, steps } : { copyId: copy, steps }, ctx);
      images.push(...(latest.images ?? []));
      wallMs.push(Number.isFinite(latest.report?.wallMs) ? Math.round(latest.report.wallMs) : null);
      if (!latest.ok) break;
      copy = latest.copyId;
    }
    if (latest.ok && copy) await stopDrive(sessionKey, { copyId: copy });
    emitProgramCardDebug(deps, "program_card_look_auto_drive", latest.ok ? "debug" : "warn", { ok: latest.ok === true,
      batches: auto.batches.length, split: auto.split.length, pace: auto.pace, startMs: auto.startMs, budgetMs: auto.budgetMs, costMs: auto.costMs, wallMs, error: latest.error ?? null }, sessionKey);
    const { drive: _drive, copyId: _copyId, calls: _calls, clockMs: _clockMs, screenWords: _screenWords, stateSummary: _stateSummary,
      problemText: _problemText, replayPlan: _replayPlan, aggregateReport, imageReport: _imageReport, next: _next, ...result } = latest;
    const aggregate = latest.ok ? lookHistory.snapshot(sessionKey, card.cardId)?.report ?? aggregateReport : aggregateReport;
    if (!aggregate) return { ...result, split: auto.split };

    const report = programCardLookUnsplit(aggregate, auto.split, auto.plan);
    const settled      = lookHistory.completeSplit(sessionKey, card.cardId, report, auto.plan);
    const { ok: _settledOk, ...history } = settled.ok ? settled : { ok: false };
    if (!latest.ok) {
      return { ...result, ...history, report, split: auto.split, images, imageReport: report,
        next: joinNext(latest.error === "look_timeout" ? PROGRAM_CARD_LOOK_TIMEOUT_NEXT : PROGRAM_CARD_LOOK_FAILED_NEXT,
          latest.notCounted === true ? programCardTestNotCountedNext(lookHistory.testsLeft(sessionKey, card.cardId)) : null) };
    }
    return { ...result, ...history, report, phoneCalls: auto.batches.length, split: auto.split, note: PROGRAM_CARD_LOOK_AUTO_DRIVE_NOTE,
      next: lookNextWithFrame(sessionKey, report, null), images, imageReport: report };
  }

  async function driveCall(sessionKey        , card     , payload     , ctx     ) {
    const used = payload.drive === true ? 0 : driveController.snapshot(sessionKey)?.calls ?? 0;
    const pace = lookPaceOf(sessionKey, card.cardId);
    const refused = refuseTooLong(sessionKey, payload.steps, pace);
    if (refused) return refused;
    const maxCalls = Math.min(PROGRAM_CARD_LOOK_AUTO_DRIVE_MAX_CALLS, PROGRAM_CARD_LOOK_DRIVE_MAX_CALLS - used);
    const auto = programCardLookAutoDrive(payload.steps, pace, maxCalls,
      payload.drive === true ? lookStartOf(sessionKey, card.cardId) : 0);
    const splitting = !!auto && auto.batches.length >= 2;
    const batches = splitting ? auto.batches : [payload.steps];
    const startedAt = Date.now();
    const { steps: _steps, ...rest } = payload;
    const done        = [];
    let latest      = null;
    for (const [index, steps] of batches.entries()) {
      latest = await driveBatch(sessionKey, card, index === 0 ? { ...rest, steps } : { copyId: latest.copyId, steps }, ctx);
      if (latest.report) done.push(latest);
      if (!latest.ok) break;
    }

    const before = done.reduce((sum        , call     ) => sum + (call.report?.steps?.length ?? 0), 0);
    let sent = batches.at(-1), playOn = 0;
    while (latest.ok && done.length < Math.min(maxCalls, PROGRAM_CARD_LOOK_DRIVE_MAX_CALLS - used - 1) &&
      Date.now() - startedAt < PROGRAM_CARD_LOOK_PLAY_ON_BY_MS) {
      const left = programCardLookPlayLeft(sent, latest.report);
      if (left === null) break;
      sent = [{ do: `play:${left}` }];
      latest = await driveBatch(sessionKey, card, { copyId: latest.copyId, steps: sent }, ctx);
      if (latest.report) { done.push(latest); playOn++; }
      if (!latest.ok) break;
    }
    if (!splitting && !playOn) return latest;
    const parts = [...(splitting ? auto.split : []),
      ...(playOn ? [{ step: payload.steps.length - 1, from: before - 1, to: before - 1 + playOn }] : [])];
    emitProgramCardDebug(deps, "program_card_look_drive_split", latest.ok ? "debug" : "warn", { ok: latest.ok === true,
      batches: batches.length, ran: done.length, split: splitting ? auto.split.length : 0, playOn,
      ...(splitting ? { pace: auto.pace, startMs: auto.startMs, budgetMs: auto.budgetMs, costMs: auto.costMs } : { pace }),
      wallMs: done.map((call     ) => Number.isFinite(call.report?.wallMs) ? Math.round(call.report.wallMs) : null), error: latest.error ?? null }, sessionKey);
    if (!done.length) return { ...latest, split: auto?.split ?? [] };
    const report = programCardLookUnsplit(programCardLookJoinReports(done.map((call     ) => call.report)), parts, payload.steps);
    lookHistory.recordVerdictReport(sessionKey, card.cardId, report);
    const images = done.flatMap((call     ) => call.images ?? []);
    const note = [splitting ? PROGRAM_CARD_LOOK_DRIVE_SPLIT_NOTE : "", playOn ? PROGRAM_CARD_LOOK_PLAY_ON_NOTE : ""].filter(Boolean).join(" ");
    const result = { ...latest, report, phoneCalls: done.length, ...(splitting ? { split: auto.split } : {}),
      ...(playOn ? { playedOn: playOn } : {}), note,
      images, imageReport: report, picturesDelivered: images.length > 0,
      picturesReason: images.length ? null : latest.picturesReason ?? null };
    if (latest.ok && typeof deps?.admitLookResult === "function" && deps.admitLookResult(result) !== true) {
      const refusal = { ok: false, error: "look_payload_too_large", failedCopy: true,
        picturesDelivered: false, picturesReason: "pictures not delivered: the drive result exceeds the host transport budget" };
      lookHistory.recordDelivery(sessionKey, card.cardId, refusal);
      deliverLookResult(sessionKey, lookHistory.receiptRequestId(sessionKey, card.cardId), card.cardId,
        { ...lookHistory.snapshot(sessionKey, card.cardId), ...refusal, metadataOnly: true });
      driveController.disconnect(sessionKey);
      return refusal;
    }
    return result;
  }

  async function replayDrive(sessionKey        , card     , payload     , plan       , ctx     ) {
    const batches = programCardLookBatches(plan, lookPaceOf(sessionKey, card.cardId), lookStartOf(sessionKey, card.cardId));
    if (!batches.length || batches.length > 8) return { ok: false, error: "look_replay_too_long" };
    let copy                = null, latest      = null;
    const images        = [];
    for (const [index, steps] of batches.entries()) {
      latest = await driveBatch(sessionKey, card, index === 0 ? { ...payload, drive: true, steps } : { copyId: copy, steps }, ctx);
      if (!latest.ok) return latest;
      copy = latest.copyId;
      images.push(...(latest.images ?? []));
    }
    const aggregate = lookHistory.snapshot(sessionKey, card.cardId)?.report;
    if (!aggregate) return { ok: false, error: "drive_history_not_found", failedCopy: true };

    lookHistory.recordVerdictReport(sessionKey, card.cardId, aggregate);
    const result = { ...latest, report: aggregate, replayed: true, replayBatches: batches.length, images, imageReport: aggregate };
    if (typeof deps?.admitLookResult === "function" && deps.admitLookResult(result) !== true) {
      const refusal = { ok: false, error: "look_payload_too_large", failedCopy: true,
        picturesDelivered: false, picturesReason: "pictures not delivered: the replay result exceeds the host transport budget" };
      lookHistory.recordDelivery(sessionKey, card.cardId, refusal);

      deliverLookResult(sessionKey, lookHistory.receiptRequestId(sessionKey, card.cardId), card.cardId,
        { ...lookHistory.snapshot(sessionKey, card.cardId), ...refusal, metadataOnly: true });
      driveController.disconnect(sessionKey);
      return refusal;
    }
    return result;
  }

  function driveCopy(sessionKey        ) {
    const live = driveController.snapshot(sessionKey);
    if (live) return { start: live.replayPlan?.start };
    const cardId = openCard(sessionKey)?.cardId;
    const stored = cardId ? lookHistory.replay(sessionKey, cardId) : null;
    return stored?.mode === "drive" ? { start: stored.start } : undefined;
  }

  async function resumeDrive(sessionKey        , card     , payload     , ctx     , reason        ) {
    const stored = lookHistory.replay(sessionKey, card.cardId);
    const finished = stored?.mode === "drive" && Array.isArray(stored.steps) ? stored.steps : [];
    const { copyId: _copyId, steps, ...rest } = payload;
    const plan = [...finished, ...steps];

    const batches = programCardLookBatches(plan, lookPaceOf(sessionKey, card.cardId), lookStartOf(sessionKey, card.cardId));
    if (batches.length > PROGRAM_CARD_LOOK_AUTO_DRIVE_MAX_CALLS) return { ok: false, error: reason };
    const start = finished.length && stored.start !== undefined ? { start: stored.start } : {};
    const result      = await replayDrive(sessionKey, card, { ...rest, ...start }, plan, ctx);
    if (!result.ok) return result;
    const keep = (result.imageReport?.pictures ?? []).map((picture     ) => picture.step >= finished.length);
    return { ...result, images: (result.images ?? []).filter((_     , i        ) => keep[i]),
      imageReport: { ...result.imageReport, pictures: (result.imageReport?.pictures ?? []).filter((_     , i        ) => keep[i]) },
      resumed: { reason, replayedSteps: finished.length }, next: PROGRAM_CARD_DRIVE_RESUMED_NEXT };
  }

  const testProves = new Map              ();
  const provesKey = (sessionKey        , cardId        ) => `${planKeyOf(sessionKey)}\u0000${cardId}`;
  function rememberProves(sessionKey        , cardId        , proves                                 , shows                                  = null) {
    const key = provesKey(sessionKey, cardId);
    testProves.delete(key);
    if (proves) testProves.set(key, { proves, shows });
    while (testProves.size > 64) testProves.delete(testProves.keys().next().value          );
  }

  const doneBuilds = new Map                                        ();
  function markBuildDone(sessionKey        , cardId        ) {
    const key = planKeyOf(sessionKey);
    doneBuilds.delete(key);
    doneBuilds.set(key, { cardId, at: Date.now() });
    while (doneBuilds.size > 64) doneBuilds.delete(doneBuilds.keys().next().value          );
  }
  function hasStudioClient(sessionKey        ) {
    try { return deps?.hasCardStudioClient?.(sessionKey) === true; } catch { return false; }
  }

  function phoneKitLevel()                {
    try { return deps?.kitLevel?.() ?? null; } catch { return null; }
  }

  function buildDoneRefusal(sessionKey        , op        ) {
    const key = planKeyOf(sessionKey);
    const done = doneBuilds.get(key);
    if (!done) return null;
    const sinceDoneMs = Date.now() - done.at;
    const card = openCard(sessionKey);
    if ((card?.cardId && card.cardId !== done.cardId) || sinceDoneMs > PROGRAM_CARD_BUILD_DONE_KEEP_MS) {
      doneBuilds.delete(key);
      return null;
    }
    if (!hasStudioClient(sessionKey)) return null;
    emitProgramCardDebug(deps, "program_card_after_done_refused", "debug", { op, sinceDoneMs }, sessionKey);
    emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { op, error: PROGRAM_CARD_BUILD_DONE_ERROR }, sessionKey);
    return { ok: false, error: PROGRAM_CARD_BUILD_DONE_ERROR, next: PROGRAM_CARD_BUILD_DONE_NEXT };
  }

  function takeSpeck(params     , sessionKey        )      {
    if (!params || typeof params !== "object" || Array.isArray(params) || !("speck" in params)) return params;
    const { speck, ...rest } = params;
    if (typeof speck === "string" && speck.trim() && typeof deps?.noteSpeck === "function") {
      try {
        deps.noteSpeck(sessionKey, speck);
      } catch {

      }
    }
    return rest;
  }

  async function lookCard(rawParams     , ctx     , extra      = {}) {
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "main";
    const params = takeSpeck(rawParams, sessionKey);
    const testing = isPlainObject(params) && params.stop !== true && params.live !== true;

    const afterDone = testing ? buildDoneRefusal(sessionKey, "look") : null;
    if (afterDone) return afterDone;
    const continuing = isPlainObject(params) && typeof params.copyId === "string" && params.copyId !== "";
    const cardId = driveController.snapshot(sessionKey)?.cardId ?? openCard(sessionKey)?.cardId ?? null;
    let sent = params;
    let proves                                  = extra?.proves ?? null;
    let shows                                  = extra?.shows ?? null;
    if (testing && !extra?.proves && Array.isArray(params.steps)) {
      const known = cardId ? lookHistory.snapshot(sessionKey, cardId) : null;
      const lines = planRequirements(writtenPlans.get(planKeyOf(sessionKey)),
        [...(Array.isArray(known?.requirements) ? known.requirements : []), ...(Array.isArray(params.requirements) ? params.requirements : [])]) ?? [];
      const split = splitProves(params.steps, lines, matchLookRequirement);
      const refused = split.unknown.length
        ? `invalid_request: proves names no ask line (${split.unknown.map((name) => JSON.stringify(name)).join(", ")}); name one of ${lines.map((line) => JSON.stringify(line)).join(", ") || "none: this card has no ask lines"}`
        : null;

      const liveHeld = liveDeclOf(sessionKey, cardId)?.uncheckedLines;
      const untested = Array.isArray(known?.tests) ? known.tests.filter((t     ) => (!t?.verdict || t.verdict === "not_tested") && !liveHeld?.has(t.requirement))
        .map((t     ) => t.requirement) : [];
      const untagged = !refused && !continuing && untested.length > 0 && Object.keys(split.proves).length === 0
        ? `invalid_request: this Test tags no ask line; give the step that shows each of ${untested.map((line        ) => JSON.stringify(line)).join(", ")} proves set to that line`
        : null;
      if (refused || untagged) {
        emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { op: "look", error: refused ? "proves_unknown_line" : "test_untagged" }, sessionKey);
        return { ok: false, error: refused ?? untagged, ...(untested.length ? { uncovered: untested } : {}) };
      }
      sent = { ...params, steps: split.steps };
      proves = split.proves;
    } else if (testing && !Array.isArray(params?.steps) && cardId && lookHistory.replay(sessionKey, cardId)?.mode === "plain") {

      const kept = testProves.get(provesKey(sessionKey, cardId));
      proves = kept?.proves ?? null;
      shows = kept?.shows ?? null;
    }

    if (testing && Array.isArray(ctx?.imageModel?.input)) {
      if (ctx.imageModel.input.includes("image")) wordsOnlyTests.delete(sessionKey);
      else wordsOnlyTests.add(sessionKey);
    }

    if (testing && !continuing && liveDeclOf(sessionKey, cardId)?.feedsSinceMs) await awaitEditedFeeds(sessionKey, cardId);
    const result      = await runLook(sent, ctx, extra);
    if (result?.ok === false && typeof result.error === "string" && !result.report) {

      if (testing && result.failedCopy === true && cardId && Array.isArray(sent?.steps) && !continuing && sent.drive !== true) {
        rememberProves(sessionKey, cardId, proves ?? {}, shows);
      }
      emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { op: "look", error: result.error.slice(0, 160) }, sessionKey);
      return result;
    }
    if (!testing || !result?.report || typeof result.cardId !== "string") return result;

    if (Array.isArray(sent?.steps) && !continuing) rememberProves(sessionKey, result.cardId, result.drive === true ? null : proves ?? {}, shows);
    const offset = Number.isInteger(result.resumed?.replayedSteps) ? result.resumed.replayedSteps : 0;
    return judgeTest(sessionKey, result, proves ? shiftProves(proves, offset) : null, extra?.first === true ? "host" : "agent",
      shows ? shiftProves(shows, offset) : null);
  }

  async function judgeTest(sessionKey        , result     , proves                                 , by                  ,
    shows                                  = null) {
    const cardId = result.cardId;
    const inChange = changing(sessionKey);
    let judged        = [];
    let stepVerdicts        = [];
    if ((proves && Object.keys(proves).length) || (shows && Object.keys(shows).length)) {

      const advisory = programCardAdvisoryLookCodesOn();
      const problems = Array.isArray(result.report?.problems) ? result.report.problems : null;

      const couldNotRun = result.ok === false && programCardTestCouldNotRun(result.error) ? result.error : null;
      const judging = problems ? { ...result.report, problems: problems.filter((problem     ) =>
        !programCardAdvisoryProblem(problem, advisory, inChange) && !(couldNotRun && problem?.code === couldNotRun)) } : result.report;
      stepVerdicts = provesVerdicts(proves ?? {}, judging, shows);
    }

    const liveParts = await liveCheck(sessionKey, cardId);
    const liveDecl = liveDeclOf(sessionKey, cardId);
    const liveLines           = liveParts.length ? lookHistory.snapshot(sessionKey, cardId)?.requirements ?? [] : [];
    const ranSteps = (Array.isArray(result.report?.steps) ? result.report.steps : []).filter((s     ) => s && !s.skipped && Number.isInteger(s.index));
    const liveFailedBefore = liveDecl?.failedLines ?? new Set        ();

    const earlier        = liveParts.length ? lookHistory.snapshot(sessionKey, cardId)?.tests ?? [] : [];
    const livePassedBefore = new Set        (earlier.filter((t     ) => t?.verdict === "passed" || t?.verdict === "fixed").map((t     ) => t.requirement));

    const liveJudgedBefore = new Set        ([...livePassedBefore, ...earlier.filter((t     ) => t?.verdict === "wearer_check").map((t     ) => t.requirement)]);
    const gate = liveGate(liveLines, stepVerdicts, liveParts, liveFailedBefore, ranSteps.length ? ranSteps[0].index : null, liveJudgedBefore);

    const liveUnchecked = new Set(gate.holds.filter((h) => h.status === "unchecked").map((h) => h.line));
    if (liveDecl) {

      liveDecl.failedLines = liveParts.length ? liveOnlyFailed(liveFailedBefore, stepVerdicts, gate, livePassedBefore) : new Set();
      liveDecl.uncheckedLines = liveUnchecked;
    }
    if (liveParts.length) emitProgramCardDebug(deps, "program_card_live_check", "debug", liveCheckDebug(liveParts, gate.holds), sessionKey);
    if (gate.verdicts.length) {
      const recorded = lookHistory.recordVerdicts(sessionKey, cardId, gate.verdicts);
      if (recorded?.ok) judged = gate.verdicts;
      else if (recorded) emitProgramCardDebug(deps, "program_card_proves_rejected", "debug", { error: String(recorded.error).slice(0, 160) }, sessionKey);
    }
    const liveFailed = liveParts.some((part) => part.status === "failed");

    if (inChange) {
      try {
        deps?.changeLiveFailed?.(sessionKey, liveFailed);
      } catch {

      }
    }

    try {
      deps?.liveFailed?.(sessionKey, inChange ? [] : liveParts.filter((part) => part.status === "failed")
        .map((part) => ({ kind: part.kind, name: part.name, reason: part.reason, ...(part.httpStatus ? { httpStatus: part.httpStatus } : {}) })));
    } catch {

    }
    const live = liveParts.length ? { live: liveCheckForAgent(liveParts, gate.holds) } : {};
    const snapshot = lookHistory.snapshot(sessionKey, cardId);
    const tests        = Array.isArray(snapshot?.tests) ? snapshot.tests : Array.isArray(result.tests) ? result.tests : [];

    if (!tests.length) return liveParts.length ? { ...result, ...live, next: joinNext(result.next, liveCheckNext(liveParts, gate.holds, !liveFailed, new Set(), inChange)) } : result;

    const liveHeld = new Set(gate.holds.filter((h) => h.status !== "waiting").map((h) => h.line));
    const uncovered = tests.filter((t     ) => (!t?.verdict || t.verdict === "not_tested") && !liveHeld.has(t.requirement)).map((t     ) => t.requirement);
    const failed = tests.filter((t     ) => t?.verdict === "still_open").map((t     ) => t.requirement);
    const hardHolds = !!result.hardCases && result.hardCases.verdict !== "fits";
    const clean = programCardLookClean(result.ok, result.report, inChange) && !hardHolds;
    const testsLeft = Math.max(0, 3 - (Number.isFinite(result.looks) ? result.looks : 1));

    const settled = clean && uncovered.length === 0 && failed.length === 0 && !liveFailed;

    const open = openFindings(sessionKey, cardId);
    const requestId = lookHistory.receiptRequestId(sessionKey, cardId);
    const delivered = !!snapshot && (judged.length > 0 || settled) &&
      deliverLookResult(sessionKey, requestId, cardId, { ...snapshot, metadataOnly: true, ...(settled ? { verdictsOnly: true } : {}) });
    const done = settled && delivered;
    if (done) markBuildDone(sessionKey, cardId);

    const change = done ? changeOf(sessionKey) : null;
    let changeSave      = null;
    if (change && !change.saved && changeTested.has(changeTestedKey(change))) {
      try {
        changeSave = await deps.changeDone(sessionKey);
      } catch {
        changeSave = { status: "rejected", card: change.name, code: "save_failed" };
      }
      emitProgramCardDebug(deps, "program_card_change_saved", "debug", { status: changeSave?.status ?? null,
        revision: changeSave?.revision ?? null, code: changeSave?.code ?? null }, sessionKey);
    }
    const cardChange                                                                            = changeSave ? { status: changeSave.status, card: changeSave.card,
      ...(changeSave.status === "saved" ? { revision: changeSave.revision } : { code: changeSave.code ?? "save_failed" }) } : null;
    const changeNext = !cardChange ? null : cardChange.status === "saved"
      ? `Saved as revision ${cardChange.revision} of ${cardChange.card}; tell the wearer, and that Revisions can undo it.`
      : cardChange.code === "saved_base_conflict"
        ? `${cardChange.card} changed while you worked, so the change was not saved over it. The draft is kept: tell the wearer they can save it as a new card from the phone.`
        : `The change could not be saved (${cardChange.code}); the draft is kept. Tell the wearer in one line.`;
    const lines                         = { passed: 0, fixed: 0, wearer_check: 0, still_open: 0, not_tested: 0 };
    for (const t of tests) { const v = typeof t?.verdict === "string" ? t.verdict : "not_tested"; lines[v] = (lines[v] ?? 0) + 1; }
    emitProgramCardDebug(deps, "program_card_watched_test", "debug", { by, looks: result.looks ?? null, drive: result.drive === true,
      tagged: proves ? Object.keys(proves).length : 0, judged: judged.length, failed: judged.filter((v) => v.outcome === "failed").length,
      clean, done, lines, open: open.map((finding     ) => finding.code),

      ...(result.ok === false ? { error: String(result.error ?? "look_failed").slice(0, 60), notCounted: result.notCounted === true } : {}) }, sessionKey);

    const stopped = result.report?.ok === false;
    const hostNext = done ? PROGRAM_CARD_TEST_DONE_NEXT
      : stopped || result.drive === true ? null
        : clean && failed.length === 0 && !liveFailed ? joinNext(programCardTestUncoveredNext(uncovered, testsLeft), programCardOpenFindingsNote(open, true))
          : programCardTestProblemsNext(testsLeft, open);
    const rest = typeof result.next === "string" && result.next.startsWith(PROGRAM_CARD_LOOK_NEXT)
      ? result.next.slice(PROGRAM_CARD_LOOK_NEXT.length).trim() : result.next;

    const liveShown = new Set([...stepVerdicts, ...gate.verdicts].map((v     ) => v.requirement));
    const liveNext = liveCheckNext(liveParts, gate.holds, done, new Set(gate.holds.filter((h) => !liveShown.has(h.line)).map((h) => h.line)), inChange);
    const next = changeNext ? joinNext(hostNext ? joinNext(hostNext, rest) : result.next, changeNext) : hostNext ? joinNext(hostNext, rest) : result.next;
    return { ...result, ...(snapshot ? { verdicts: snapshot.verdicts, tests: snapshot.tests } : {}),
      ...(uncovered.length ? { uncovered } : {}), hostTest: { by, judged: judged.length, done },
      ...(cardChange ? { cardChange } : {}), ...live,
      next: liveNext ? joinNext(next, liveNext) : next };
  }

  async function runLook(params     , ctx     , extra      = {}) {
    const sessionKey = typeof ctx?.sessionKey === "string" && ctx.sessionKey.trim() ? ctx.sessionKey.trim() : "main";
    const validation = validateLookInput(params, driveCopy(sessionKey), { internal: extra?.internalSteps === true });
    if (!validation.ok) return validation;
    const driveInput = isProgramCardLookDriveInput(validation.payload);

    const phoneBack = hasCapableClient() || (await capableClientBack(sessionKey, "look"));
    if (!phoneBack) return noClient();
    if (validation.payload.live === true && !hasLiveCaptureClient()) return { ok: false, error: "unsupported" };
    if (driveInput && !hasDriveLookClient()) return { ok: false, error: "unsupported" };
    if (!driveInput && validation.payload.live !== true && (typeof deps?.hasLookClient !== "function" || deps.hasLookClient() !== true)) {
      return { ok: false, error: "no_client" };
    }
    if (validation.payload.steps?.some((step     ) => step.every !== undefined) && deps?.hasPlayLookClient?.() !== true) {
      return { ok: false, error: PROGRAM_CARD_LOOK_PLAY_UNSUPPORTED };
    }
    if (validation.payload.steps?.some(isPlayStep) && deps?.hasPlayRunLookClient?.() !== true) {
      return { ok: false, error: PROGRAM_CARD_LOOK_PLAY_RUN_UNSUPPORTED };
    }
    if (validation.payload.stop === true) return stopDrive(sessionKey, validation.payload, validation.ignored);
    let activeDrive = driveController.snapshot(sessionKey);

    if (activeDrive && (validation.payload.drive === true || !driveInput && validation.payload.live !== true)) {
      if (activeDrive.pending) return { ok: false, error: "drive_copy_already_live", copyId: activeDrive.copyId };
      await releaseDrive(sessionKey, activeDrive);
      activeDrive = null;
    }

    if (activeDrive && validation.payload.copyId) validation.payload.copyId = activeDrive.copyId;
    const open = openCard(sessionKey);
    const card = validation.payload.copyId && activeDrive
      ? open?.cardId === activeDrive.cardId ? open : { cardId: activeDrive.cardId }
      : open;
    if (!card?.cardId) return cardReady(sessionKey) ? readyRefusal() : { ok: false, error: "no_card", next: PROGRAM_CARD_LOOK_CLOSED_NEXT };
    if (validation.payload.live === true) {
      if (validation.payload.steps || validation.payload.start || validation.payload.requirements?.length) return invalid("live captures the accepted frame only; omit steps, start and requirements");
      const outcome = await roundTrip(sessionKey, { title: "", source: "", why: "", op: "look", payload: { live: true, cardId: card.cardId } },
        Number.isFinite(deps.lookTimeoutMs) ? deps.lookTimeoutMs : PROGRAM_CARD_LOOK_TIMEOUT_MS);
      return captureAnswer(outcome, card.cardId, { ...ctx, sessionKey }, true);
    }

    const writtenPlan = !driveInput || validation.payload.drive === true ? writtenPlans.get(planKeyOf(sessionKey)) : undefined;
    if (writtenPlan) {
      writtenPlans.delete(planKeyOf(sessionKey));
      validation.payload.requirements = planRequirements(writtenPlan, validation.payload.requirements);
    }
    if (driveInput) {
      if (validation.payload.requirements?.length) rememberOpenProgramCardAsks(sessionKey, card.cardId,
        { requirements: validation.payload.requirements }, globalThis, true);
      const continuing = typeof validation.payload.copyId === "string";
      if (continuing && !activeDrive) return resumeDrive(sessionKey, card, validation.payload, { ...ctx, sessionKey }, "drive_copy_not_found");
      const result      = await driveCall(sessionKey, card, validation.payload, { ...ctx, sessionKey });
      if (continuing && result.ok === false && result.error === "look_drive_not_found") {
        return resumeDrive(sessionKey, card, validation.payload, { ...ctx, sessionKey }, result.error);
      }
      return result;
    }
    const storedReplay = !validation.payload.steps ? lookHistory.replay(sessionKey, card.cardId) : null;
    if (storedReplay?.mode === "drive" && Array.isArray(storedReplay.steps)) {
      if (!hasDriveLookClient()) return { ok: false, error: "look_replay_requires_drive" };
      const replayPayload = { ...validation.payload,
        ...(storedReplay.start !== undefined ? { start: storedReplay.start } : {}) };
      return replayDrive(sessionKey, card, replayPayload, storedReplay.steps, { ...ctx, sessionKey });
    }
    const plainPlan = validation.payload.steps ?? (storedReplay?.mode === "plain" ? storedReplay.steps : null);
    const pace = lookPaceOf(sessionKey, card.cardId);
    const splittable = validation.payload.live !== true && hasDriveLookClient();
    const refused = splittable ? refuseTooLong(sessionKey, plainPlan, pace) : null;
    if (refused) return refused;

    const sweep = Array.isArray(extra?.cases) ? { cases: extra.cases, resultAtMs: extra.resultAtMs }
      : validation.payload.live !== true ? taskBuildLookCases(sessionKey) : null;
    const cases = sweep && sweep.cases.length && validation.payload.live !== true &&
      deps?.hasCasesLookClient?.() === true ? sweep.cases : null;
    const auto = splittable && !cases ? programCardLookAutoDrive(plainPlan, pace, PROGRAM_CARD_LOOK_AUTO_DRIVE_MAX_CALLS,
      lookStartOf(sessionKey, card.cardId)) : null;

    if (auto && auto.batches.length >= 2) return autoDrive(sessionKey, card, validation.payload, auto, { ...ctx, sessionKey });
    const reservation = lookHistory.reserve(sessionKey, card.cardId, validation.payload);
    if (!reservation.ok) return withLookLimitNext(reservation);
    if (validation.payload.requirements?.length) rememberOpenProgramCardAsks(sessionKey, card.cardId,
      { requirements: validation.payload.requirements }, globalThis, true);
    const live = withGameLive(reservation.payload);
    const outcome = await roundTrip(sessionKey, { title: "", source: "", why: "", op: "look",
      payload: cases ? { ...live.payload, cases } : live.payload },
      (Number.isFinite(deps.lookTimeoutMs) ? deps.lookTimeoutMs : PROGRAM_CARD_LOOK_TIMEOUT_MS) + (cases ? PROGRAM_CARD_LOOK_CASES_HOST_MS : 0) + live.extraMs);

    if (outcome?.ok !== true && !outcome?.result?.report) return { ok: false, error: outcome?.error || "look_failed", ...testNotCounted(sessionKey, card.cardId) };
    if (outcome.result?.cardId && outcome.result.cardId !== card.cardId) return { ok: false, error: "card_changed", ...testNotCounted(sessionKey, card.cardId) };
    if (outcome.error === "look_payload_too_large") return { ok: false, error: outcome.error, failedCopy: true };

    const phoneFailed = outcome?.ok !== true || outcome?.result?.report?.ok === false;
    const checked = validateLookReport(outcome.result?.report, { partial: phoneFailed });
    if (!checked.ok) return checked;

    emitProgramCardDebug(deps, "program_card_look_pace", "debug", { ok: !phoneFailed, error: checked.report.error ?? null, pace,
      costMs: Array.isArray(plainPlan) ? Math.round(plainPlan.reduce((sum        , step     ) => sum + programCardLookStepCostMs(step, pace), 0)) : null,
      wallMs: Number.isFinite(checked.report.wallMs) ? Math.round(checked.report.wallMs) : null, frames: checked.report.frames ?? null,
      setupMs: Number.isFinite(checked.report.setupMs) ? Math.round(checked.report.setupMs) : null,
      steps: checked.report.steps.length, ...(cases ? lookCasesDebug(checked.report) : {}) }, sessionKey);
    const model = ctx?.imageModel ?? { model: "unknown", input: [] };
    const ok = outcome?.ok === true && checked.report.ok !== false;
    const { images: allImages, ...pictures } = lookToolPictures(checked.report, ok ? model : { ...model, input: [] });

    const fresh = lookPicturesNotYetSent(checked.report, allImages, lookHistory.sentPictures(sessionKey, card.cardId));
    const images = fresh.images;
    const receiptStatus = { ok, error: ok ? null : outcome?.error || checked.report.error || "look_failed", failedCopy: !ok };

    const history = lookHistory.complete(sessionKey, card.cardId, checked.report, { ...pictures, ...receiptStatus }, outcome.requestId);
    const stoppedNext = checked.report.ok !== false ? null
      : checked.report.error === "look_timeout" ? PROGRAM_CARD_LOOK_TIMEOUT_NEXT : PROGRAM_CARD_LOOK_FAILED_NEXT;

    const hardCases = cases ? taskCaseVerdict(cases, checked.report, { looks: history.looks, resultAtMs: sweep?.resultAtMs,
      ...(typeof card.source === "string" ? { sourceHash: liveuiLibraryDigest({ kind: "source", source: card.source }) } : {}),
      ...((sweep       )?.parts ? { parts: (sweep       ).parts, source: card.source } : {}) }) : null;
    if (hardCases) emitProgramCardDebug(deps, "program_card_task_verdict", "debug", { verdict: hardCases.verdict, ran: hardCases.ran,
      failed: hardCases.failed, real: hardCases.real, looks: hardCases.looks,
      codes: [...new Set(hardCases.problems.map((p     ) => p.code))].slice(0, 8) }, sessionKey);
    const hardNext = hardCases ? taskCaseVerdictNext(hardCases.verdict, 3 - history.looks) : null;
    const notCountedNext = history.notCounted ? programCardTestNotCountedNext(lookHistory.testsLeft(sessionKey, card.cardId)) : null;
    const result = { ...receiptStatus, cardId: card.cardId, report: lookReportWithoutPixels(checked.report), ...history, ...pictures,
      ...(hardCases ? { hardCases } : {}),
      next: joinNext(lookNextWithFrame(sessionKey, checked.report, stoppedNext), hardNext, notCountedNext) };
    if (typeof deps?.admitLookResult === "function" && deps.admitLookResult({ ...result, images }) !== true) {
      const delivery = { picturesDelivered: false, picturesReason: "pictures not delivered: the Look result exceeds the host transport budget" };
      const refusal = { ok: false, error: "look_payload_too_large", failedCopy: true, ...delivery };
      lookHistory.recordDelivery(sessionKey, card.cardId, refusal);
      deliverLookResult(sessionKey, outcome.requestId, card.cardId, { ...result, ...refusal });
      emitProgramCardDebug(deps, "program_card_look_images", "debug", { host: model.host || "unknown", model: model.model || "unknown", pixelsSent: false, pictures: 0, error: refusal.error }, sessionKey);
      return refusal;
    }
    deliverLookResult(sessionKey, outcome.requestId, card.cardId, result);
    lookHistory.recordSentPictures(sessionKey, card.cardId, fresh.sent);
    emitProgramCardDebug(deps, "program_card_look_images", "debug", { host: model.host || "unknown", model: model.model || "unknown", pixelsSent: images.length > 0, pictures: images.length,
      inputSource: model.inputSource ?? null,
      unchanged: fresh.unchanged.length }, sessionKey);
    return { ...result, ...(fresh.unchanged.length ? { picturesUnchanged: fresh.unchanged, picturesNote: LOOK_PICTURES_UNCHANGED_NOTE } : {}),
      images, imageReport: { pictures: fresh.pictures } };
  }

  const unsubscribe =
    deps.relay.onProgramCardResponse((msg     ) => {
      if (!msg || typeof msg.requestId !== "string") return;
      pending.resolve(msg.requestId, msg);
    }) || (() => {});

  const testSessions = new Map                ();
  const unsubscribePlayScreen = typeof deps.relay.onProgramCardPlayScreen === "function"
    ? deps.relay.onProgramCardPlayScreen((msg     ) => {
      const sessionKey = msg && typeof msg.requestId === "string" ? testSessions.get(msg.requestId) : undefined;
      if (sessionKey) startFrameAtPlayScreen(sessionKey, msg.frameLayout);
    }) || (() => {}) : () => {};

  const unsubscribeFrameChanged = typeof deps.relay.onProgramCardFrameChanged === "function"
    ? deps.relay.onProgramCardFrameChanged((change     ) => { void takeFrameChange(change); }) || (() => {}) : () => {};

  async function takeFrameChange(change     ) {
    if (!change || typeof change.appId !== "string" || typeof change.code !== "string" || !Number.isSafeInteger(change.number)) return;
    const cardKey = `app:${change.appId}`;
    let sessions           = [];
    try { sessions = deps?.sessionsShowing?.(cardKey) ?? []; } catch { return; }
    for (const sessionKey of sessions) {
      await oneAtATime(sessionKey, async () => {
        const card = openCard(sessionKey);
        if (!card?.cardId || card.key !== cardKey) return;
        const removed = !change.frame;
        if (card.unsaved > 0 || card.saved?.revision !== change.base?.revision) {
          emitProgramCardDebug(deps, "program_card_frame_changed", "debug", { ok: false, appId: change.appId, removed,
            skipped: card.unsaved > 0 ? "unsaved" : "other_revision", revision: card.saved?.revision ?? null }, sessionKey);
          return;
        }
        const saved = { appId: change.appId, revision: change.number, ...(typeof change.sourceHash === "string" ? { sourceHash: change.sourceHash } : {}) };
        const outcome      = await roundTrip(sessionKey, { title: "", source: "", why: "", op: "edit", payload: { source: change.code, saved } }, timeoutMs);
        emitProgramCardDebug(deps, "program_card_frame_changed", outcome?.ok ? "debug" : "warn", { ok: outcome?.ok === true, appId: change.appId,
          revision: change.number, removed, ...(outcome?.ok ? {} : { error: String(outcome?.error ?? "refused").slice(0, 200) }) }, sessionKey);
        if (!outcome?.ok) return;
        noteGameCode(sessionKey, change.code);
        frameLane.adopt(sessionKey, card.cardId, change.frame ?? null, change.brief ?? null);
        driveController.edited(sessionKey);
      });
    }
  }

  async function writeCard(rawParams     , ctx     ) {
    const sessionKey =
      ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
        ? ctx.sessionKey.trim()
        : "main";
    const params = takeSpeck(rawParams, sessionKey);
    const validation = validateProgramCardInput(params);
    if (!validation.ok) {
      emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { error: validation.error }, sessionKey);
      return toolResult(validation);
    }
    if (!hasCapableClient() && !(await capableClientBack(sessionKey, "write"))) return toolResult(noClient());

    doneBuilds.delete(planKeyOf(sessionKey));

    liveDecls.delete(planKeyOf(sessionKey));
    const writtenAt = Date.now();
    const pictureFiles = programCardPictureFilePaths(validation.card.source).length
      ? await embedPictureFiles(sessionKey, [validation.card.source]) : { ok: true         , texts: [validation.card.source] };
    if (!pictureFiles.ok) {
      emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { error: pictureFiles.error.slice(0, 160), pictureFiles: true }, sessionKey);
      return toolResult({ error: pictureFiles.error });
    }
    validation.card.source = pictureFiles.texts[0];

    const kitRefusal = programCardKitRefusal(validation.card.source, phoneKitLevel());
    if (kitRefusal) {
      emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { error: kitRefusal.slice(0, 160), kit: true }, sessionKey);
      keepRefusal(sessionKey, params, ctx);
      return toolResult({ error: kitRefusal, next: PROGRAM_CARD_REFUSED_KEPT_NEXT });
    }

    const statesRefusal = isTaskCardBuild(sessionKey) ? programCardTaskStatesRefusal(validation.card.source) : null;
    if (statesRefusal) {
      emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { error: statesRefusal.slice(0, 160), taskStates: true }, sessionKey);
      keepRefusal(sessionKey, params, ctx);
      return toolResult({ error: statesRefusal, next: PROGRAM_CARD_REFUSED_KEPT_NEXT });
    }

    let writeRefusal = mcpWriteGate(sessionKey, validation.card.source, []);

    if (writeRefusal && typeof writeRefusal.then === "function") writeRefusal = await writeRefusal;
    if (writeRefusal) return toolResult(writeRefusal);

    const { description, asks, ...card } = validation.card;
    if (description) rememberProgramCardDescription(card.source, description);

    linkPlanIconToSource(sessionKey, card.source);
    let asksRequest      = null;

    frameLane.forget(sessionKey, { keepIdea: true });
    const about = { title: card.title, request: typeof description?.request === "string" ? description.request : "",
      plan: Array.isArray(ctx?.plan) ? ctx.plan.filter((line     ) => typeof line === "string" && line.trim()) : [],
      game: typeof ctx?.game === "boolean" ? ctx.game            : null };
    const outcome = typeof deps.writeDraft === "function" && deps.supportsDrafts?.(sessionKey)
      ? await oneAtATime(sessionKey, async () => {

        const call = phoneCall.getStore();
        if (call) call.draft = true;
        const sent      = await deps.writeDraft(sessionKey, { ...card, ...(asks ? { asks } : {}) });
        noteGameCode(sessionKey, sent?.ok === true ? card.source : null, about);
        return sent;
      })
      : await oneAtATime(sessionKey, async () => {
        const sent      = await roundTrip(sessionKey, card, timeoutMs,
          requestId => { asksRequest = beginProgramCardAsks(requestId, sessionKey, card.source, asks); });
        noteGameCode(sessionKey, sent?.ok === true ? card.source : null, about);
        return sent;
      });
    const shown = outcome && outcome.ok === true && outcome.shown === true;

    const ready = !!outcome && outcome.ok === true && !shown && outcome.error === PROGRAM_CARD_READY_NOT_SHOWN;
    if (outcome?.ok === true) markCardReady(sessionKey, ready);
    if (asksRequest) finishProgramCardAsks(asksRequest, shown || ready, outcome?.clientId, outcome?.sessionKey, globalThis, ready ? PROGRAM_CARD_READY_ASKS_MS : 0);

    const refused = isCodeRefusal(outcome);
    if (refused) keepRefusal(sessionKey, params, ctx);
    else if (outcome && (outcome.ok === true || outcome.persisted === true)) keptRefusals.delete(planKeyOf(sessionKey));
    if (outcome && (outcome.ok === true || outcome.persisted === true)) {
      const plan = Array.isArray(ctx?.plan) ? ctx.plan.filter((line     ) => typeof line === "string" && line.trim()) : [];
      writtenPlans.delete(planKeyOf(sessionKey));
      if (plan.length) {
        writtenPlans.set(planKeyOf(sessionKey), plan);
        if (writtenPlans.size > 64) writtenPlans.delete(writtenPlans.keys().next().value          );
      }
    }

    if (outcome?.ok === true) prepareWrittenFrameIdea(sessionKey, card.source);

    if (outcome?.ok === true) {
      noteLiveDecl(sessionKey, { sinceMs: writtenAt, feedsSinceMs: 0, feeds: HTTP_FEED_SOURCE.test(card.source), feedsSure: true,
        written: card.source.slice(0, OPEN_CARD_SOURCE_CAP), title: String(card.title ?? "").trim().slice(0, 80) });
    }
    if (ready) {
      return toolResult({ ...outcome, error: null, ready: true, jev: undefined, mcp: undefined, model: undefined, next: joinNext(outcome.next, PROGRAM_CARD_READY_NEXT) });
    }
    const jevCard = shown ? jevCardOf(outcome.jev) : null;

    const mcpCard = shown ? jevCardOf(outcome.mcp) : null;
    const modelCard = shown ? jevCardOf(outcome.model) : null;

    const refreshCard = shown ? agentRefreshCardOf(outcome.refresh) : null;
    const note = openCardNote(shown);
    if (!jevCard && !mcpCard && !modelCard && !refreshCard) {
      const written = toolResult({ ...outcome, jev: undefined, mcp: undefined, refresh: undefined,
        next: joinNext(outcome && outcome.next, note, refused ? PROGRAM_CARD_REFUSED_KEPT_NEXT : "") });
      return shown ? withFirstLook(sessionKey, written, await firstLook(sessionKey, card.source, asks, ctx)) : written;
    }
    const jev      = jevCard ? await considerJev(sessionKey, jevCard, "write") : {};
    const mcp      = mcpCard ? await considerMcp(sessionKey, mcpCard, "write") : {};
    const model      = modelCard ? await considerModel(sessionKey, modelCard, "write") : {};
    const refresh      = refreshCard ? await considerAgentRefresh(sessionKey, refreshCard, "write") : {};

    noteLiveDecl(sessionKey, {
      ...(jevCard ? { jev: { key: jevCard.key, uses: jevCard.uses, answer: jev.jev } } : {}),
      ...(mcpCard ? { mcp: { key: mcpCard.key, uses: mcpCard.uses, answer: mcp.mcp } } : {}),
      ...(modelCard ? { model: { key: modelCard.key, uses: modelCard.uses, answer: model.model } } : {}),
    });
    const written = toolResult({ ...outcome, jev: jev.jev, mcp: mcp.mcp, mcpWrites: mcp.mcpWrites, model: model.model,
      refresh: undefined, ...(refresh.agentRefresh ? { agentRefresh: refresh.agentRefresh } : {}),
      next: joinNext(jev.next, mcp.next, model.next, refresh.next, note) });
    return withFirstLook(sessionKey, written, await firstLook(sessionKey, card.source, asks, ctx));
  }

  async function settleCardSites(sessionKey        , source        ) {

    const location = LOCATION_FEED_SOURCE.test(source);
    if (typeof deps?.settleCardSites !== "function" || (!HTTP_FEED_SOURCE.test(source) && !FEEDS_SOURCE.test(source) && !location)) return;
    const open = openCard(sessionKey);
    if (!open?.cardId) return;
    let settled      = null;
    try {
      settled = await deps.settleCardSites({ sessionKey, card: open.cardId, name: open.title || "", ...(location ? { location: true } : {}) });
    } catch {
      settled = null;
    }
    emitProgramCardDebug(deps, "program_card_sites_settled", "debug", settled
      ? { feeds: settled.feeds, asked: settled.asked, allowed: settled.allowed, ready: settled.ready, ms: settled.ms,

        ...(Number.isInteger(settled.refused) ? { refused: settled.refused } : {}),
        ...(settled.location ? { locationAsked: settled.location.asked === true } : {}) }
      : { error: "unavailable" }, sessionKey);
  }

  const liveFeedText = (source     ) => typeof source === "string"
    ? (source.match(/https?:\/\/[^"'`\s]+|\$(?:\.[A-Za-z_]\w*|\[\d+\])+|\bevery\s*:\s*\d+|\bkind["'`]?\s*:\s*["'`]\w+["'`]/g) ?? []).join("\n") : "";

  function noteLiveDecl(sessionKey        , fields     ) {
    const key = planKeyOf(sessionKey);
    const merged = { sinceMs: Date.now(), feedsSinceMs: 0, ...(liveDecls.get(key) ?? {}), ...fields };
    liveDecls.delete(key);
    liveDecls.set(key, merged);
    while (liveDecls.size > 64) liveDecls.delete(liveDecls.keys().next().value          );
  }

  async function liveCheck(sessionKey        , cardId        ) {

    const decl = liveDeclOf(sessionKey, cardId);
    if (!decl || typeof deps?.liveParts !== "function") return [];
    if (!decl.cardId) {

      const open = openCard(sessionKey);
      const other = decl.written !== undefined && decl.title !== undefined && open?.cardId === cardId && typeof open.source === "string" &&
        open.source.slice(0, OPEN_CARD_SOURCE_CAP) !== decl.written && String(open.title ?? "").trim().slice(0, 80) !== decl.title;
      if (other) return [];
      decl.cardId = cardId;
    }
    const feeds = decl.feeds === true;
    const mcpParts = decl.mcp ? liveUseParts("mcp", decl.mcp.uses, decl.mcp.answer) : [];
    const useParts = [...(decl.jev ? liveUseParts("jev", decl.jev.uses, decl.jev.answer) : []),
      ...(decl.model ? liveUseParts("model", decl.model.uses, decl.model.answer) : [])];
    if (!feeds && !mcpParts.length && !useParts.length) return [];
    const mcpAllowed = mcpParts.some((part) => part.status === "ok");
    let read      = null;
    const sinceMs = feeds ? decl.feedsSinceMs : 0;

    decl.feedsSinceMs = 0;

    const noSubscribeWait = feeds && (decl.feedsSure === false || decl.feedsAwaited === true);
    decl.feedsAwaited = false;
    if (feeds || mcpAllowed) {
      try {
        read = await deps.liveParts({ sessionKey, card: cardId, feeds, mcp: mcpAllowed,
          ...(mcpAllowed ? { key: decl.mcp.key } : {}), sinceMs,
          ...(noSubscribeWait ? { subscribeWaitMs: 0 } : {}) });
      } catch {
        read = null;
      }
    }

    const feedParts = !feeds ? [] : Array.isArray(read?.feeds) ? liveFeedParts(read.feeds)
      : decl.feedsSure === false ? [] : [{ kind: "feed"         , name: "feed", status: "unchecked"         , reason: "not_run", words: [] }];

    const parts = [...feedParts, ...liveMcpCalled(mcpParts, read?.mcp, decl.mcpSinceMs ?? decl.sinceMs), ...useParts];

    const key = decl.mcp?.key ?? decl.jev?.key ?? decl.model?.key;
    if (typeof key !== "string" || typeof deps?.cardHealth !== "function" || !parts.some((part) => part.kind !== "feed" && part.status === "unchecked")) return parts;
    try {
      return liveHealthRefined(parts, deps.cardHealth(key, sessionKey));
    } catch {
      return parts;
    }
  }

  async function awaitEditedFeeds(sessionKey        , cardId               ) {
    const decl = liveDeclOf(sessionKey, cardId);
    if (!decl?.feedsSinceMs || typeof deps?.liveParts !== "function") return;

    if (decl.feeds !== true) { decl.feedsSinceMs = 0; return; }
    decl.feedsAwaited = true;
    try {

      if (decl.feedsSure === false) {
        const standing = await deps.liveParts({ sessionKey, card: cardId, feeds: true, mcp: false, sinceMs: 0, subscribeWaitMs: 0, waitMs: 0 });
        if (!Array.isArray(standing?.feeds)) return;
      }
      await deps.liveParts({ sessionKey, card: cardId, feeds: true, mcp: false, sinceMs: decl.feedsSinceMs });
    } catch {

    }
  }

  async function firstLook(sessionKey        , source               , asks     , ctx     , before                = null) {
    if (deps?.firstLook === false || typeof deps?.hasLookClient !== "function" || deps.hasLookClient() !== true) return null;
    const waitMs = Number.isFinite(deps?.firstLookOpenWaitMs) ? deps.firstLookOpenWaitMs : PROGRAM_CARD_FIRST_LOOK_OPEN_WAIT_MS;
    const reported = typeof source === "string" ? source.slice(0, OPEN_CARD_SOURCE_CAP) : null;
    const replaced = typeof before === "string" ? before.slice(0, OPEN_CARD_SOURCE_CAP) : null;
    const isReported = (open     ) => reported !== null ? open?.source === reported : typeof open?.source === "string" && open.source !== replaced;
    const reportedOpen = async () => {
      for (let waited = 0; !isReported(openCard(sessionKey)); waited += FIRST_LOOK_POLL_MS) {
        if (waited >= waitMs) {
          emitProgramCardDebug(deps, "program_card_first_look", "debug", { ok: false, error: "card_not_reported_open" }, sessionKey);
          return false;
        }
        await new Promise((resolve) => setTimeoutFn(resolve, FIRST_LOOK_POLL_MS));
      }
      return true;
    };
    if (!await reportedOpen()) return null;
    await settleCardSites(sessionKey, source ?? openCard(sessionKey)?.source ?? "");

    if (!await reportedOpen()) return null;
    const requirements = Array.isArray(asks?.requirements) ? asks.requirements.slice(0, 6) : [];

    try {

      const lines = planRequirements(writtenPlans.get(planKeyOf(sessionKey)), requirements) ?? requirements;
      if (lines.length) {
        const controls = Array.isArray(openCard(sessionKey)?.commands) ? openCard(sessionKey).commands : [];
        const game = isDirectInputSource(source ?? openCard(sessionKey)?.source ?? "");
        const play = deps?.hasPlayRunLookClient?.() === true;
        const test = hostFirstTest(lines, controls, { game, play, wearerOnly: isWearerOnlyLine });

        const showLines = new Set(Object.values(test.shows).flat()).size;
        const tagged = Object.keys(test.proves).length;
        const hosted = tagged > 0 || showLines > 0;
        emitProgramCardDebug(deps, "program_card_built_in_test", "debug", { source: hosted ? "host" : "standard", steps: test.steps.length, controls: controls.length,
          game, play, lines: lines.length, tagged, shows: showLines, covered: test.covered.length, uncovered: test.uncovered.length }, sessionKey);
        if (hosted) {
          return await lookCard({ requirements: lines, steps: test.steps, why: "First test of the new card" }, { ...ctx, sessionKey },
            { proves: test.proves, shows: test.shows, first: true, internalSteps: true });
        }
        return await lookCard({ requirements: lines, why: "First test of the new card" }, { ...ctx, sessionKey }, { first: true });
      }
      return await lookCard({ why: "First test of the new card" }, { ...ctx, sessionKey });
    } catch (err     ) {
      return { ok: false, error: String(err?.message || "look_failed").slice(0, 120) };
    }
  }

  function taskBuildLookCases(sessionKey        )                                                                 {
    if (deps?.hasCasesLookClient?.() !== true || typeof deps?.taskBuildCard !== "function") return null;
    let card      = null;
    try { card = deps.taskBuildCard(sessionKey); } catch { card = null; }
    const cases = card ? taskHardCases(card) : null;
    const checked = cases ? validateLookCases(cases) : null;
    const parts = Array.isArray(card?.taskSlots) ? card.taskSlots
      .map((slot     ) => typeof slot === "string" ? slot : slot?.name).filter((name     ) => typeof name === "string") : [];
    emitProgramCardDebug(deps, "program_card_look_cases", "debug", { task: !!card, cases: checked?.ok ? checked.cases.length : 0,
      ...(checked && !checked.ok ? { error: checked.error } : {}) }, sessionKey);
    return checked?.ok ? { cases: checked.cases, ...(Number.isFinite(card?.atMs) ? { resultAtMs: card.atMs } : {}),
      ...(parts.length > 1 ? { parts } : {}) } : null;
  }

  function withFirstLook(sessionKey        , written     , look     ) {
    if (!look) return written;
    const { images = [], imageReport, aggregateReport: _aggregateReport, next: lookNext, ...result } = look;

    const frameNote = typeof lookNext === "string" && lookNext.includes(PROGRAM_CARD_FRAME_DRAWING_NOTE) ? PROGRAM_CARD_FRAME_DRAWING_NOTE : null;

    const cannotAt = typeof lookNext === "string" ? lookNext.indexOf(PROGRAM_CARD_FRAME_CANNOT_LEAD) : -1;
    const cannotEnd = cannotAt >= 0 ? (lookNext          ).indexOf(PROGRAM_CARD_FRAME_CANNOT_END, cannotAt) : -1;
    const cannotNote = cannotEnd >= 0 ? (lookNext          ).slice(cannotAt, cannotEnd + PROGRAM_CARD_FRAME_CANNOT_END.length) : null;
    const report = result.report;

    const hard = result.hardCases;
    const hardHolds = !!hard && hard.verdict !== "fits";
    const hardNext = hardHolds ? taskCaseVerdictNext(hard.verdict, 3 - (Number.isFinite(result.looks) ? result.looks : 1)) : null;
    const clean = programCardLookClean(result.ok, report, changing(sessionKey)) && !hardHolds;
    const advice = clean ? report.problems.length : 0;
    const tested = Array.isArray(result.tests) && result.tests.length > 0;

    const host = report && report.ok !== false && result.hostTest ? result.hostTest : null;

    const liveFailed = Array.isArray(result.live?.parts) && result.live.parts.some((part     ) => part?.status === "failed");
    const done = host ? host.done === true : clean && !liveFailed && !tested && !!result.cardId && deliverLookResult(sessionKey,
      lookHistory.receiptRequestId(sessionKey, result.cardId), result.cardId,
      { ...lookHistory.snapshot(sessionKey, result.cardId), metadataOnly: true, verdictsOnly: true });

    if (done && !host && typeof result.cardId === "string") markBuildDone(sessionKey, result.cardId);
    const hostNext = host ? joinNext(PROGRAM_CARD_FIRST_TEST_NOTE,
      typeof lookNext === "string" ? lookNext.replace(PROGRAM_CARD_FRAME_DRAWING_NOTE, "").trim() : null) : "";
    const cleanDoneNext = hasStudioClient(sessionKey) ? PROGRAM_CARD_FIRST_LOOK_CLEAN_DONE_STUDIO_NEXT : PROGRAM_CARD_FIRST_LOOK_CLEAN_DONE_NEXT;

    const liveNote = !host && Array.isArray(result.live?.parts) ? liveCheckNext(result.live.parts, [], done, new Set(), changing(sessionKey)) : null;
    const next = !report ? PROGRAM_CARD_FIRST_LOOK_FAILED_NEXT
      : host ? hostNext
        : clean && !liveFailed ? (done ? cleanDoneNext : PROGRAM_CARD_FIRST_LOOK_CLEAN_UNTESTED_NEXT)
          : joinNext(PROGRAM_CARD_FIRST_LOOK_PROBLEMS_NEXT, hardNext, liveNote);
    emitProgramCardDebug(deps, "program_card_first_look", "debug", { ok: result.ok === true, clean, tested, done, advice, frame: !!frameNote,
      problems: Array.isArray(report?.problems) ? report.problems.length : null,
      codes: Array.isArray(report?.problems) ? [...new Set(report.problems.map((p     ) => p?.code).filter(Boolean))] : null,
      failedExpects: (report?.steps ?? []).filter((step     ) => step?.expectOutcome === "failed").length, error: result.error ?? null }, sessionKey);

    const isReport = !!report && typeof report === "object" && !Array.isArray(report);
    const { frameLayout: _frameLayout, ...forAgent } = isReport ? report : ({}       );

    if (isReport && Array.isArray(forAgent.problems)) forAgent.problems = withLookStateLimitProblem(report, forAgent.problems);
    return { ...written, firstLook: { ...result, ...(isReport ? { report: forAgent } : {}), clean }, next: joinNext(written.next, next, clean && !liveFailed ? liveNote : null, advice ? PROGRAM_CARD_FIRST_LOOK_ADVICE_NOTE : null, frameNote, host ? null : cannotNote),
      ...(images.length ? { images } : {}), ...(imageReport ? { imageReport } : {}) };
  }

  function healthNext(sessionKey        , card     , part                         , answer        ) {
    if (typeof deps?.health !== "function" || typeof card?.key !== "string") return "";

    const fits = answer === "declined" ? (reason        ) => WEARER_NO.has(reason)
      : answer === "off" || answer === "unavailable" ? (reason        ) => !WEARER_NO.has(reason) && reason !== "waiting"
        : null;
    if (!fits) return "";
    try { return composeCardHealthNext(deps.health(card.key, sessionKey, { [part]: card.uses }), part, Date.now(), fits); } catch { return ""; }
  }

  async function considerModel(sessionKey        , card     , cause        ) {
    if (typeof deps?.considerModel !== "function") return { model: "off" };
    try {
      const verdict = await deps.considerModel({ sessionKey, ...card, cause });
      if (verdict.answer === "allowed") return { model: verdict.answer, next: "The wearer allowed the model uses." };

      if (verdict.answer === "invalid") {
        return { model: "invalid", next: `The host refused the card's model block: ${String(verdict.error || "invalid").slice(0, 300)}` };
      }
      return { model: verdict.answer, next: healthNext(sessionKey, card, "model", verdict.answer)
        || `Models in cards: ${verdict.answer}. The wearer can manage this card on the phone (${PROGRAM_CARD_ACCESS_WHERE}).` };
    } catch (_) { return { model: "no_answer" }; }
  }

  async function considerMcp(sessionKey        , card     , cause        ) {
    if (!deps || typeof deps.considerMcp !== "function") return {};
    let verdict      = null;
    try {
      verdict = await deps.considerMcp({ sessionKey, ...card, cause });
    } catch {
      verdict = null;
    }
    const answer = verdict && typeof verdict.answer === "string" ? verdict.answer : "no_answer";

    const writes = verdict && typeof verdict.writes === "string" ? verdict.writes : null;
    const writesNext = writes ? MCP_WRITES_NEXT[writes] || MCP_WRITES_NEXT.not_granted : "";
    if (answer === "invalid") {
      return { mcp: "invalid", ...(writes ? { mcpWrites: writes } : {}),
        next: joinNext(`The host refused the card's mcp block: ${String(verdict.error || "invalid").slice(0, 300)}`, writesNext) };
    }

    const readsNext = verdict && verdict.reads === 0 ? ""
      : answer === "allowed" ? MCP_NEXT.allowed : healthNext(sessionKey, card, "mcp", answer) || MCP_NEXT[answer] || MCP_NEXT.no_answer;
    return { mcp: answer, ...(writes ? { mcpWrites: writes } : {}), next: joinNext(readsNext, writesNext) };
  }

  function mcpWriteGate(sessionKey        , source               , keys     )      {
    const gated = programCardMcpWriteGate(deps?.checkMcpWrites, sessionKey, source, keys);
    return gated && typeof gated.then === "function" ? gated.then((refused     ) => noteWriteRefusal(sessionKey, refused)) : noteWriteRefusal(sessionKey, gated);
  }

  function noteWriteRefusal(sessionKey        , refused     ) {
    if (refused) emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { error: refused.error, reason: refused.reason ?? null,
      uses: Array.isArray(refused.writeUses) ? refused.writeUses.map((u     ) => u.why) : null }, sessionKey);
    return refused;
  }

  async function considerJev(sessionKey        , card     , cause        ) {
    if (!deps || typeof deps.considerJev !== "function") return {};
    let verdict      = null;
    try {
      verdict = await deps.considerJev({ sessionKey, ...card, cause });
    } catch {
      verdict = null;
    }
    const answer = verdict && typeof verdict.answer === "string" ? verdict.answer : "no_answer";
    if (answer === "invalid") {
      return { jev: "invalid", next: `The host refused the card's jev block: ${String(verdict.error || "invalid").slice(0, 300)}` };
    }
    return { jev: answer, next: answer === "allowed" ? JEV_NEXT.allowed : healthNext(sessionKey, card, "jev", answer) || JEV_NEXT[answer] || JEV_NEXT.no_answer };
  }

  function agentRefreshRefusal(card     )                {
    if (!card?.cardId || card.agentRefresh !== true) return card?.cardId ? PROGRAM_CARD_AGENT_REFRESH_NOT_DECLARED : PROGRAM_CARD_AGENT_REFRESH_NOT_ALLOWED;
    let allowed = false;
    try { allowed = typeof card.key === "string" && deps?.agentRefreshAllowed?.(card.key) === true; } catch { allowed = false; }
    return allowed ? null : PROGRAM_CARD_AGENT_REFRESH_NOT_ALLOWED;
  }

  async function considerAgentRefresh(sessionKey        , card     , cause        ) {
    if (!card || typeof deps?.considerAgentRefresh !== "function") return {};
    let answer = "no_answer";
    try { answer = (await deps.considerAgentRefresh({ sessionKey, ...card, cause }))?.answer || "no_answer"; } catch { answer = "no_answer"; }
    return { agentRefresh: answer, next: AGENT_REFRESH_NEXT[answer] || AGENT_REFRESH_NEXT.no_answer };
  }

  async function talk(op                    , rawParams     , ctx     ) {
    const sessionKey =
      ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()
        ? ctx.sessionKey.trim()
        : "main";

    const afterDone = buildDoneRefusal(sessionKey, op);
    if (afterDone) return afterDone;

    const editObject = op === "edit" && rawParams && typeof rawParams === "object" && !Array.isArray(rawParams);
    const replaces = editObject && rawParams.replaces !== undefined ? rawParams.replaces : undefined;

    const notChecks = editObject && rawParams.notChecks !== undefined ? rawParams.notChecks : undefined;
    const unreplaced = replaces === undefined && notChecks === undefined ? rawParams
      : (({ replaces: _replaces, notChecks: _notChecks, ...rest }     ) => rest)(rawParams);
    const params = op === "edit" ? takeSpeck(unreplaced, sessionKey) : rawParams;
    const validation = op === "command" ? validateCardCommandInput(params) : validateCardEditInput(params);
    if (!validation.ok) {
      emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { op, error: validation.error }, sessionKey);
      return { ok: false, error: validation.error };
    }
    if (!hasCapableClient() && !(await capableClientBack(sessionKey, op))) return noClient();
    if (op === "edit" && (validation.payload.source !== undefined || validation.payload.edits !== undefined)) {

      const edits = validation.payload.edits;
      const named = (list          ) => list.some((text        ) => programCardPictureFilePaths(text).length);
      const finds = edits ? edits.map((e     ) => e.find) : [];
      const texts = validation.payload.source !== undefined ? [validation.payload.source] : edits.map((e     ) => e.replace);
      const found = named(finds) ? await embedPictureFiles(sessionKey, finds, true) : { ok: true         , texts: finds };
      if (!found.ok) return { ok: false, error: found.error };
      const pictureFiles = named(texts) ? await embedPictureFiles(sessionKey, texts) : { ok: true         , texts };
      if (!pictureFiles.ok) return { ok: false, error: pictureFiles.error };
      if (validation.payload.source !== undefined) validation.payload.source = pictureFiles.texts[0];
      else validation.payload.edits = edits.map((e     , i        ) => ({ ...e, find: found.texts[i], replace: pictureFiles.texts[i] }));

      const framed = typeof validation.payload.source === "string" ? frameLane.frameOf(sessionKey, openCard(sessionKey)?.cardId ?? "") : null;
      if (framed && !isFrameWrapped(validation.payload.source)) {
        validation.payload.source = wrapProgramCardFrame(validation.payload.source, { png: framed.png, art: framed.art, place: framed.place,
          brief: frameLane.briefOf(sessionKey, openCard(sessionKey)?.cardId ?? "") });
      }

      const upgrade = Array.isArray(validation.payload.edits) ? frameFitsUpgrade(openCard(sessionKey)?.source) : null;
      if (upgrade && validation.payload.edits.length < PROGRAM_CARD_LIMITS.editsMax && !validation.payload.edits.some((e     ) => typeof e?.find === "string" && e.find.includes(upgrade.find.trim()))) {
        validation.payload.edits = [...validation.payload.edits, upgrade];
      }
    }

    const spoken = op === "edit" && (validation.payload.source !== undefined || validation.payload.edits !== undefined)
      ? spokenChangeTarget(sessionKey) : null;
    if (spoken) await openSpokenChange(sessionKey, spoken);
    const card = openCard(sessionKey);

    if (op === "command" && validation.payload.id === PROGRAM_CARD_REFRESH_COMMAND) {
      const refused = agentRefreshRefusal(card);
      if (refused) {
        emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { op, error: refused.split(":")[0] }, sessionKey);
        return { ok: false, shown: false, error: refused };
      }
    }

    const kept = op === "edit" && (validation.payload.edits !== undefined || validation.payload.source !== undefined)
      ? keptRefusal(sessionKey) : null;
    if (kept) {
      const fixed      = typeof validation.payload.source === "string" ? { source: validation.payload.source }
        : programCardApplyEdits(kept.params.source, validation.payload.edits);

      if (typeof fixed.source === "string" || !card?.cardId) {
        if (typeof fixed.source !== "string") return { ok: false, shown: false, error: fixed.error, next: PROGRAM_CARD_REFUSED_KEPT_NEXT };
        emitProgramCardDebug(deps, "program_card_refusal_fixed", "debug", { edits: Array.isArray(validation.payload.edits) ? validation.payload.edits.length : 0,
          sourceLength: fixed.source.length }, sessionKey);
        const written = await writeCard({ ...kept.params, source: fixed.source }, { ...kept.ctx, sessionKey });
        return { ...written, fixedRefusedWrite: true, next: joinNext(PROGRAM_CARD_REFUSED_FIXED_NEXT, written.next) };
      }
    }
    const captureRequested = op === "command" && validation.payload.capture === true;
    if (captureRequested && !hasLiveCaptureClient()) return { ok: false, error: "unsupported" };

    if (!card?.cardId && cardReady(sessionKey)) return readyRefusal();
    if (captureRequested && !card?.cardId) return { ok: false, error: "no_card", next: PROGRAM_CARD_LOOK_CLOSED_NEXT };
    const { asks, ...phonePayload } = validation.payload;

    if (op === "edit" && (phonePayload.source !== undefined || phonePayload.edits !== undefined)) {
      const known = card?.source && card.source.length < OPEN_CARD_SOURCE_CAP ? card.source : null;
      const after = typeof phonePayload.source === "string" ? phonePayload.source
        : programCardSourceAfterEdits(known, phonePayload.edits)

          ?? (Array.isArray(phonePayload.edits) ? phonePayload.edits.map((e     ) => (typeof e?.replace === "string" ? e.replace : "")).join("\n") : null);

      const kitRefusal = programCardKitRefusal(after ?? "", phoneKitLevel());
      if (kitRefusal && !(known && programCardKitRefusal(known, phoneKitLevel()))) {
        emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { op, error: kitRefusal.slice(0, 160), kit: true }, sessionKey);
        return { ok: false, shown: false, error: kitRefusal };
      }

      const whole = typeof phonePayload.source === "string" ? phonePayload.source : programCardSourceAfterEdits(known, phonePayload.edits);
      const statesRefusal = whole && isTaskCardBuild(sessionKey) ? programCardTaskStatesRefusal(whole) : null;
      if (statesRefusal && !(known && programCardTaskStatesRefusal(known))) {
        emitProgramCardDebug(deps, "program_card_tool_refused", "debug", { op, error: statesRefusal.slice(0, 160), taskStates: true }, sessionKey);
        return { ok: false, shown: false, error: statesRefusal };
      }
      let writeRefusal = mcpWriteGate(sessionKey, after, "open");
      if (writeRefusal && typeof writeRefusal.then === "function") writeRefusal = await writeRefusal;
      if (writeRefusal) return { ...writeRefusal, shown: false };
    }
    if (op === "edit" && (phonePayload.source !== undefined || phonePayload.edits !== undefined)) driveController.edited(sessionKey);

    const editShape = op === "edit" ? programCardEditShape(phonePayload, card?.source) : null;

    const ignoredSourceChars = editShape?.mode === "edits" && typeof params?.source === "string" ? params.source.length : 0;
    if (editShape) emitProgramCardDebug(deps, "program_card_tool_edit_shape", "debug", { ...editShape, ignoredSourceChars }, sessionKey);
    const commandLabel = op === "command" ? card?.commands?.find((command     ) => command.id === phonePayload.id)?.label : null;
    const editSentAt = Date.now();
    const send = () => roundTrip(sessionKey, { title: "", source: "", why: "", op, payload: phonePayload,

      ...(op === "edit" ? { agentEdit: true } : {}),
      ...(op === "command" ? { cardKnownOpen: !!card?.cardId } : {}),
      ...(typeof commandLabel === "string" ? { commandLabel } : {}) }, captureRequested ? PROGRAM_CARD_LOOK_TIMEOUT_MS : timeoutMs);

    const outcome      = op === "edit" && (phonePayload.source !== undefined || phonePayload.edits !== undefined)
      ? await oneAtATime(sessionKey, async () => {
        const sent      = await send();
        if (sent?.ok === true) {

          const kept = gameCode.get(planKeyOf(sessionKey));
          noteGameCode(sessionKey, typeof phonePayload.source === "string" ? phonePayload.source
            : programCardSourceAfterEdits(kept?.source ?? null, phonePayload.edits),
          kept && otherCardTitle(kept.title, card?.title) ? { game: null } : {});
        }
        return sent;
      })
      : await send();
    if (captureRequested) return captureAnswer(outcome, card.cardId, { ...ctx, sessionKey });
    const result = outcome && typeof outcome.result === "object" && outcome.result ? outcome.result : {};
    const { ok: _ok, shown: _shown, error: _error, next: _next, jev: phoneJev, mcp: phoneMcp, model: phoneModel, ...rest } = result;
    const ok = !!(outcome && outcome.ok === true);
    const shown = ok && outcome.shown === true;
    if (shown && asks && card?.cardId) rememberOpenProgramCardAsks(sessionKey, card.cardId, asks);

    const jevCard = shown && op === "edit" ? jevCardOf(phoneJev) : null;
    const mcpCard = shown && op === "edit" ? jevCardOf(phoneMcp) : null;
    const jev      = jevCard ? await considerJev(sessionKey, jevCard, "edit") : {};
    const mcp      = mcpCard ? await considerMcp(sessionKey, mcpCard, "edit") : {};
    const model      = shown && op === "edit" && jevCardOf(phoneModel) ? await considerModel(sessionKey, jevCardOf(phoneModel), "edit") : {};

    if (ok && op === "edit" && (phonePayload.source !== undefined || phonePayload.edits !== undefined)) {
      const known = liveDecls.get(planKeyOf(sessionKey));

      const before = typeof card?.source === "string" ? card.source : "";
      if (known?.cardId && card?.cardId && known.cardId !== card.cardId) liveDecls.delete(planKeyOf(sessionKey));

      const cut = before.length >= OPEN_CARD_SOURCE_CAP;
      if (!liveDecls.has(planKeyOf(sessionKey))) {
        noteLiveDecl(sessionKey, { sinceMs: editSentAt, feedsSinceMs: 0, feeds: cut || HTTP_FEED_SOURCE.test(before), feedsSure: !cut,
          ...(card?.cardId ? { cardId: card.cardId } : {}) });
      }
      const whole = typeof phonePayload.source === "string" ? phonePayload.source : cut ? null : programCardSourceAfterEdits(before, phonePayload.edits);
      const after = whole ?? `${before}\n${Array.isArray(phonePayload.edits)
        ? phonePayload.edits.map((e     ) => (typeof e?.replace === "string" ? e.replace : "")).join("\n") : ""}`;
      const feedsChanged = liveFeedText(before) !== liveFeedText(after);

      const feeds = typeof whole === "string" ? { feeds: HTTP_FEED_SOURCE.test(whole), feedsSure: true } : { feeds: true, feedsSure: false };

      const modelCard = shown ? jevCardOf(phoneModel) : null;
      noteLiveDecl(sessionKey, {
        ...feeds,

        written: typeof whole === "string" ? whole.slice(0, OPEN_CARD_SOURCE_CAP) : undefined,
        ...(shown ? {
          jev: jevCard ? { key: jevCard.key, uses: jevCard.uses, answer: jev.jev } : undefined,
          mcp: mcpCard ? { key: mcpCard.key, uses: mcpCard.uses, answer: mcp.mcp } : undefined,
          model: modelCard ? { key: modelCard.key, uses: modelCard.uses, answer: model.model } : undefined,

          ...(mcpCard ? { mcpSinceMs: editSentAt } : {}),
        } : {}),
        ...(feedsChanged ? { feedsSinceMs: editSentAt } : {}),
      });
    }
    const next = joinNext(
      jev.next, mcp.next, model.next,
      result.persisted === false ? "The card changed locally, but its latest checkpoint was not kept on the host. Do not claim this change is recoverable after restart." : "",
      ok && !shown ? (result.persisted === true ? "The draft checkpoint was kept, but the card is not open. Use glasses_card_draft launch to ask for display approval." : "The operation completed, but the card is not open on the glasses. Do not say it is visible, saved or recoverable after restart. Do not rebuild or save a duplicate card to work around this.") : "",
      outcome?.error === "card_not_open" ? "The card is not open; this operation did not run. Do not claim the change is done or rebuild or save a duplicate card." : "",

      op === "edit" && outcome?.error === "card_not_open" ? PROGRAM_CARD_EDIT_CLOSED_NEXT : "",
      outcome?.error === PROGRAM_CARD_READY_NOT_SHOWN ? PROGRAM_CARD_READY_WAIT_NEXT : "",
      ok && editShape ? programCardEditResentNext(editShape) : "",
      op === "edit" && typeof outcome?.error === "string" && outcome.error.startsWith("edits[") && keptRefusal(sessionKey)
        ? PROGRAM_CARD_REFUSED_KEPT_EDIT_NOTE : "",
    );

    const held = outcome?.error === PROGRAM_CARD_READY_NOT_SHOWN;
    if (held) markCardReady(sessionKey, true);
    const answered = {
      ok,
      shown,
      ...(held ? { ready: true } : {}),
      error: outcome && typeof outcome.error === "string" ? outcome.error : null,
      ...rest,
      ...(jev.jev ? { jev: jev.jev } : {}),
      ...(mcp.mcp ? { mcp: mcp.mcp } : {}),
      ...(mcp.mcpWrites ? { mcpWrites: mcp.mcpWrites } : {}),
      ...(model.model ? { model: model.model } : {}),
      ...(next ? { next } : {}),
    };

    const codeEdited = op === "edit" && ok && (phonePayload.source !== undefined || phonePayload.edits !== undefined);

    const landedDraft = codeEdited && typeof result.draft?.draftId === "string" ? result.draft.draftId : null;
    let change = codeEdited ? changeOf(sessionKey) : null;
    if (codeEdited && !change && landedDraft && asideChange(sessionKey)?.draftId === landedDraft) {
      let on = false;
      try {
        on = typeof deps?.changeRevive === "function" && (await deps.changeRevive(sessionKey, landedDraft)) === true;
      } catch {
        on = false;
      }
      if (on) change = changeOf(sessionKey);
    }

    if (change && !change.saved && !landedDraft && result.persisted === false) {
      changeTested.delete(changeTestedKey(change));
      try {
        await deps?.changeTested?.(sessionKey, false);
      } catch {

      }
      emitProgramCardDebug(deps, "program_card_change_unkept", "debug", { draftId: change.draftId }, sessionKey);
      return answered;
    }
    if (change && landedDraft !== change.draftId) change = null;
    if (!change || change.saved || changeTested.has(changeTestedKey(change))) return answered;
    changeTested.add(changeTestedKey(change));
    while (changeTested.size > 64) changeTested.delete(changeTested.values().next().value          );

    try {
      await deps?.changeTested?.(sessionKey);
    } catch {

    }
    const before = card?.source ?? null;
    const after = typeof phonePayload.source === "string" ? phonePayload.source
      : before && before.length < OPEN_CARD_SOURCE_CAP ? programCardSourceAfterEdits(before, phonePayload.edits) : null;

    let lines           = change.lines;
    let replaced = 0;
    let told = 0;
    if (replaces !== undefined || notChecks !== undefined) {
      let took      = null;
      try {
        took = typeof deps?.changeReplace === "function" ? await deps.changeReplace(sessionKey, replaces, notChecks) : null;
      } catch {
        took = null;
      }
      if (Array.isArray(took?.lines)) lines = took.lines;
      replaced = Array.isArray(took?.replaced) ? took.replaced.length : 0;
      told = Array.isArray(took?.notChecks) ? took.notChecks.length : 0;
    }
    writtenPlans.delete(planKeyOf(sessionKey));
    if (lines.length) writtenPlans.set(planKeyOf(sessionKey), lines.slice());
    emitProgramCardDebug(deps, "program_card_change_test", "debug", { lines: lines.length, known: typeof after === "string",
      ...(replaces !== undefined ? { replaces: Array.isArray(replaces) ? replaces.length : -1, replaced } : {}),
      ...(notChecks !== undefined ? { notChecks: Array.isArray(notChecks) ? notChecks.length : -1, told } : {}) }, sessionKey);
    return withFirstLook(sessionKey, answered, await firstLook(sessionKey, after, null, ctx, before));
  }

  const changeTested = new Set        ();

  const changeTestedKey = (change     )         =>
    Number.isSafeInteger(change?.round) && change.round > 0 ? `${change.draftId}#${change.round}` : change.draftId;

  function spokenChangeTarget(sessionKey        )      {
    if (typeof deps?.changeSpoken !== "function" || changeOf(sessionKey)?.saved === null) return null;
    const open = openCard(sessionKey);
    const appId = typeof open?.key === "string" && open.key.startsWith("app:") ? open.key.slice(4) : "";
    return appId && open?.saved && open.unsaved === 0 ? { appId, state: open.state } : null;
  }
  async function openSpokenChange(sessionKey        , target     ) {
    const { appId, state } = target;
    const open = { state };
    let opened      = null;
    try {
      opened = await deps.changeSpoken(sessionKey, { appId, ...(open.state !== undefined ? { state: open.state } : {}) });
    } catch {
      opened = null;
    }
    if (opened) emitProgramCardDebug(deps, "program_card_change_spoken", "debug", { lines: Array.isArray(opened.lines) ? opened.lines.length : 0 }, sessionKey);
  }

  function changing(sessionKey        )          {
    const change = changeOf(sessionKey);
    return !!change && !change.saved;
  }

  function asideChange(sessionKey        )      {
    try {
      const change = typeof deps?.changeOf === "function" ? deps.changeOf(sessionKey) : null;
      return change && change.ended === true && !change.saved && typeof change.draftId === "string" ? change : null;
    } catch {
      return null;
    }
  }

  function changeOf(sessionKey        )      {
    try {
      const change = typeof deps?.changeOf === "function" ? deps.changeOf(sessionKey) : null;

      return change && typeof change.draftId === "string" && Array.isArray(change.lines) && change.ended !== true ? change : null;
    } catch {
      return null;
    }
  }

  async function roundTrip(sessionKey        , request     , waitMs = timeoutMs, onRequestId                       ) {
    const requestId = newRequestId();
    const promise = pending.register(sessionKey, requestId);
    const op = request.op || "write";

    if (op === "look") testSessions.set(requestId, sessionKey);
    try {
      return await roundTripSent(sessionKey, request, requestId, promise, op, waitMs, onRequestId);
    } finally {
      testSessions.delete(requestId);
    }
  }
  async function roundTripSent(sessionKey        , request     , requestId        , promise              , op        , waitMs        ,
    onRequestId                       ) {
    try {
      onRequestId?.(requestId);
      deps.relay.sendProgramCardRequest({ sessionKey, requestId, ...request });
      emitProgramCardDebug(
        deps,
        "program_card_tool_request_send",
        "debug",
        { requestId, sessionKey, op, sourceLength: typeof request.source === "string" ? request.source.length : 0 },
        sessionKey,
      );
    } catch (err     ) {
      emitProgramCardDebug(
        deps,
        "program_card_tool_request_send_error",
        "warn",
        {
          requestId,
          sessionKey,
          code: err && typeof err.code === "string" ? err.code : null,
          errorMessage: err && err.message ? err.message : String(err),
        },
        sessionKey,
      );

      const call = phoneCall.getStore();
      if (call) call.sent = typeof err?.code === "string" ? err.code : "";
      pending.resolve(requestId, err?.code === "unsupported" ? { error: "unsupported" } : { error: "no_client", next: PROGRAM_CARD_NO_CLIENT_NEXT });
    }

    let timeoutHandle      = null;
    if (Number.isFinite(waitMs) && waitMs > 0) {
      timeoutHandle = setTimeoutFn(() => {
        emitProgramCardDebug(deps, "program_card_tool_timeout", "warn", { requestId, timeoutMs: waitMs }, sessionKey);
        pending.resolve(requestId, { error: "timeout" });
      }, waitMs);
    }
    const outcome = await promise;
    if (timeoutHandle !== null) clearTimeoutFn(timeoutHandle);
    const result = toolResult(outcome);
    emitProgramCardDebug(
      deps,
      "program_card_tool_outcome",
      result.ok ? "debug" : "warn",
      { requestId, op, ...result },
      sessionKey,
    );
    return outcome;
  }

  async function phoneWhy(run                    ) {
    const call                                     = {};
    const result = await phoneCall.run(call, run);

    const general = result?.next === PROGRAM_CARD_NO_CLIENT_NEXT;
    const told      = withCardPhoneWhy(general ? { ...result, next: "" } : result, () => {
      const connected = typeof deps?.hasAppClient === "function" ? deps.hasAppClient() : null;
      return {
        connected: connected === true ? true : connected === false ? false : null,
        cards: hasCapableClient(),

        lacksCall: !general && call.sent === undefined && call.draft !== true && result?.error !== "client_changed",

        ...(call.sent === "unsupported" ? { here: false } : {}),
      };
    });
    if (!general) return told;
    return told.next ? { ...told, next: `${told.next} ${NO_CLIENT_NOTHING}` } : result;
  }

  return {
    writeCard: (rawParams     , ctx     ) => phoneWhy(() => writeCard(rawParams, ctx)),
    talk: (op                    , rawParams     , ctx     ) => phoneWhy(() => talk(op, rawParams, ctx)),
    lookCard: (rawParams     , ctx     , extra      = {}) => phoneWhy(() => lookCard(rawParams, ctx, extra)),
    hasCapableClient,
    prepareFrameIdea,
    drainSession: (sessionKey        , outcome     ) => { endClientWaits(sessionKey); driveController.endTurn(sessionKey); lookHistory.clear(sessionKey);
      for (const key of [...testProves.keys()]) if (key.startsWith(`${planKeyOf(sessionKey)}\u0000`)) testProves.delete(key);

      doneBuilds.delete(planKeyOf(sessionKey));
      wordsOnlyTests.delete(sessionKey);
      deps?.relay?.clearProgramCardLookResults?.(sessionKey); return pending.drainSession(sessionKey, outcome); },
    disconnectSession: (sessionKey        ) => { markCardReady(sessionKey, false); return driveController.disconnect(sessionKey); },
    drainAll: (outcome     ) => { endClientWaits(null); driveController.dispose(); lookHistory.clear(); wordsOnlyTests.clear(); deps?.relay?.clearProgramCardLookResults?.(); return pending.drainAll(outcome); },
    dispose() {
      unsubscribe();
      unsubscribePlayScreen();
      unsubscribeFrameChanged();
      endClientWaits(null);
      driveController.dispose();
    },
  };
}

function resolveToolSessionKey(ctx     , service     ) {
  if (ctx && typeof ctx.sessionKey === "string" && ctx.sessionKey.trim()) {
    return ctx.sessionKey.trim();
  }
  if (service && typeof service.peekSessionKey === "function") {
    const sessionKey = service.peekSessionKey();
    if (typeof sessionKey === "string" && sessionKey.trim()) return sessionKey.trim();
  }
  return "main";
}

function resolveDedicatedEvenAiSessionKey(service     ) {
  try {
    return service?.getRuntimeConfig?.()?.evenAiDedicatedSessionKey || null;
  } catch {
    return null;
  }
}

const HANDLER_SCOPE_SYMBOL = Symbol.for("ocuclaw.program-card.sharedHandler");

function prepareProgramCardFrameIdea(sessionKey        , game                                                    , scopeHost      = globalThis)          {
  const record = scopeHost?.[HANDLER_SCOPE_SYMBOL];
  return typeof record?.handler?.prepareFrameIdea === "function" ? record.handler.prepareFrameIdea(sessionKey, game) === true : false;
}

function registerProgramCardTool(api     , service     , opts      = {}) {
  if (!api || typeof api.registerTool !== "function") {
    throw new Error("registerProgramCardTool requires api.registerTool");
  }
  if (!service) {
    throw new Error("registerProgramCardTool requires the OcuClaw relay service");
  }
  const scopeHost =
    opts && opts.scopeHost && typeof opts.scopeHost === "object" ? opts.scopeHost : globalThis;
  const askGate = opts && typeof opts.askGate === "function" ? opts.askGate : null;
  const onCardWritten = opts && typeof opts.onCardWritten === "function" ? opts.onCardWritten : null;

  const askPlan = opts && typeof opts.askPlan === "function" ? opts.askPlan : null;

  const askGame = opts && typeof opts.askGame === "function" ? opts.askGame : null;

  let record = scopeHost[HANDLER_SCOPE_SYMBOL];
  if (!record) {
    const openCards = createOpenCardStore();
    let onResponse      = null;
    let onPlayScreen      = null;
    let onFrameChanged      = null;
    const created = createProgramCardToolHandler({
      pictureFileScope: (key        ) => service.programCardPictureFileScope?.(key) ?? null,
      supportsDrafts: (key        ) => service.supportsProgramCardDrafts?.(key) === true,
      writeDraft: (key        , card     ) => service.writeProgramCardDraft(key, card),
      notesOn: () => typeof service.cardBuildNotesOn === "function" && service.cardBuildNotesOn() === true,
      taskFor: (key        ) => typeof service.cardBuildTaskFor === "function" ? service.cardBuildTaskFor(key) : null,

      changeOf: (key        ) => typeof service.cardBuildChangeOf === "function" ? service.cardBuildChangeOf(key) : null,
      changeDone: (key        ) => typeof service.cardBuildChangeDone === "function" ? service.cardBuildChangeDone(key) : null,
      changeTested: (key        , tested = true) => typeof service.cardBuildChangeTested === "function" ? service.cardBuildChangeTested(key, tested) : null,
      changeRevive: (key        , draftId        ) =>
        typeof service.cardBuildChangeRevive === "function" ? service.cardBuildChangeRevive(key, draftId) : false,
      changeLiveFailed: (key        , failed         ) =>
        typeof service.cardBuildChangeLiveFailed === "function" ? service.cardBuildChangeLiveFailed(key, failed) : null,
      liveFailed: (key        , parts       ) =>
        typeof service.cardBuildLiveFailed === "function" ? service.cardBuildLiveFailed(key, parts) : null,
      changeReplace: (key        , numbers     , notChecks      ) =>
        typeof service.cardBuildChangeReplace === "function" ? service.cardBuildChangeReplace(key, numbers, notChecks) : null,

      changeSpoken: (key        , open     ) => typeof service.cardBuildChangeSpoken === "function" ? service.cardBuildChangeSpoken(key, open) : null,
      relay: {
        sendProgramCardRequest: (msg     ) => service.sendProgramCardRequest(msg),
        sendProgramCardLookResult: (msg     ) => service.sendProgramCardLookResult?.(msg),
        clearProgramCardLookResults: (sessionKey     ) => service.clearProgramCardLookResults?.(sessionKey),
        onProgramCardResponse: (cb     ) => {
          onResponse = cb;
          return service.onProgramCardResponse(cb);
        },

        onProgramCardPlayScreen: (cb     ) => {
          onPlayScreen = cb;
          return service.onProgramCardPlayScreen?.(cb) ?? (() => {});
        },

        onProgramCardFrameChanged: (cb     ) => {
          onFrameChanged = cb;
          return service.onProgramCardFrameChanged?.(cb) ?? (() => {});
        },
      },
      hasCapableClient: () =>
        typeof service.hasConnectedAppClientCapability === "function" &&
        service.hasConnectedAppClientCapability(PROGRAM_CARD_CAPABILITY) === true,

      ...(typeof service.hasConnectedAppClient === "function" ? { hasAppClient: () =>
        typeof service.getRelay === "function" && !service.getRelay() ? null : service.hasConnectedAppClient() === true } : {}),

      clientAwayMs: () => service.programCardClientAwayMs?.() ?? null,
      hasLookClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_CAPABILITY) === true,
      hasPicturesClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_PICTURES_CAPABILITY) === true,
      hasDriveLookClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_DRIVE_CAPABILITY) === true,
      hasPlayLookClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_PLAY_CAPABILITY) === true,
      hasPlayRunLookClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_PLAY_RUN_CAPABILITY) === true,
      hasCasesLookClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_CASES_CAPABILITY) === true,

      hasCardStudioClient: (key        ) => service.hasCardStudioClient?.(key) === true,

      kitLevel: () => service.programCardKitLevel?.() ?? null,

      taskBuildCard: (key        ) => service.cardBuildTestCard?.(key) ?? null,
      hasLiveCaptureClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY) === true,

      frameComplete: () => service.programCardFrameComplete?.() ?? null,

      frameDetail: () => service.programCardFrameDetail?.() ?? null,

      noteFrameBrief: (source        , brief     ) => service.noteProgramCardFrameBrief?.(source, brief),
      holdBuildDone: (key        , settled                  , maxMs        ) =>
        service.holdCardBuildDone?.(key, settled, maxMs) === true,

      noteSpeck: (key        , text        ) => service.noteCardBuildSpeck?.(key, text),
      hasFrameDrawClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_FRAME_DRAW_CAPABILITY) === true,

      hasFrameIdeaClient: () => service.hasConnectedAppClientCapability?.(PROGRAM_CARD_FRAME_IDEA_CAPABILITY) === true,
      noteFrameIdea: (key        , idea        ) => service.noteCardBuildFrameIdea?.(key, idea),
      getOpenCard: (sessionKey        ) => openCards.get(sessionKey),
      sessionsShowing: (cardKey        ) => openCards.sessionsShowing(cardKey),
      isCardReady: (sessionKey        ) => openCards.isReady(sessionKey),
      markCardReady: (sessionKey        , held         ) => openCards.markReady(sessionKey, held),

      ...(Number.isFinite(opts?.firstLookOpenWaitMs) ? { firstLookOpenWaitMs: opts.firstLookOpenWaitMs } : {}),
      ...(typeof service.considerProgramCardJev === "function"
        ? { considerJev: (params     ) => service.considerProgramCardJev(params) }
        : {}),

      liveParts: (params     ) =>
        typeof service.liveProgramCardParts === "function" ? service.liveProgramCardParts(params) : null,

      cardHealth: (key        , sessionKey        ) =>
        typeof service.programCardHealth === "function" ? service.programCardHealth(key, sessionKey) : [],

      settleCardSites: (params     ) =>
        typeof service.settleProgramCardSites === "function" ? service.settleProgramCardSites(params) : null,
      ...(typeof service.considerProgramCardMcp === "function"
        ? { considerMcp: (params     ) => service.considerProgramCardMcp(params) }
        : {}),
      ...(typeof service.checkProgramCardMcpWrites === "function"
        ? { checkMcpWrites: (params     ) => service.checkProgramCardMcpWrites(params) }
        : {}),
      considerModel: (params     ) => service.considerProgramCardModel(params),

      ...(typeof service.programCardHealth === "function"
        ? { health: (key        , sessionKey        , declared     ) => service.programCardHealth(key, sessionKey, declared) }
        : {}),
      ...(typeof service.considerProgramCardAgentRefresh === "function"
        ? { considerAgentRefresh: (params     ) => service.considerProgramCardAgentRefresh(params) }
        : {}),
      ...(typeof service.programCardAgentRefreshAllowed === "function"
        ? { agentRefreshAllowed: (key     ) => service.programCardAgentRefreshAllowed(key) }
        : {}),
      emitDebug: (event        , severity        , data     , context      = {}) => {
        if (typeof service.emitDebug === "function") {
          service.emitDebug(
            "relay.session",
            event,
            severity,
            { sessionKey: context.sessionKey || undefined },
            () => data || {},
          );
        }
      },
    });

    const onContext = (frame     ) => {
      if (frame && typeof frame.sessionKey === "string") openCards.report(frame.sessionKey, frame.card);
    };
    const onDisconnect = (event     ) => { if (typeof event?.sessionKey === "string") created.disconnectSession(event.sessionKey); };
    const onSessionLeft = (event     ) => { if (typeof event?.sessionKey === "string") created.disconnectSession(event.sessionKey); };
    record = { handler: created, onResponse, onPlayScreen, onFrameChanged, openCards, onContext, onDisconnect, onSessionLeft, refs: 0, modelContexts: new Map() };
    scopeHost[HANDLER_SCOPE_SYMBOL] = record;
  } else {
    if (record.onResponse) service.onProgramCardResponse(record.onResponse);
    if (record.onPlayScreen) service.onProgramCardPlayScreen?.(record.onPlayScreen);
    if (record.onFrameChanged) service.onProgramCardFrameChanged?.(record.onFrameChanged);
  }
  if (typeof service.onProgramCardContext === "function") service.onProgramCardContext(record.onContext);
  if (typeof service.onAppClientDisconnect === "function") service.onAppClientDisconnect(record.onDisconnect);
  if (typeof service.onAppClientSessionLeft === "function") service.onAppClientSessionLeft(record.onSessionLeft);
  const handler = record.handler;
  record.refs += 1;

  function currentImageModel(ctx     , sessionKey        ) {
    let config;
    try {
      config = typeof ctx.getRuntimeConfig === "function" ? ctx.getRuntimeConfig()
        : ctx.runtimeConfig ?? ctx.config ?? (typeof api.runtime?.config?.current === "function" ? api.runtime.config.current() : api.config);
    } catch {  }

    return programCardImageModel(config, { ...(ctx.activeModel ?? { provider: ctx.modelProviderId, modelId: ctx.modelId }), ...(record.modelContexts.get(sessionKey) ?? {}) },
      (provider        , model        ) => service.getHostModelInput?.(provider, model) ?? null);
  }

  const has = (capability        ) => service.hasConnectedAppClientCapability?.(capability) === true;
  const lookOffered = () => has(PROGRAM_CARD_LOOK_CAPABILITY) || has(PROGRAM_CARD_LOOK_DRIVE_CAPABILITY);
  function toolDescription(base        , op                              ) {
    let description = base;
    if (op === "write" && has(PROGRAM_CARD_FIRMWARE_TEXT_CAPABILITY)) {
      description = description.replace(PROGRAM_CARD_FIRMWARE_FONT_ESTIMATE, PROGRAM_CARD_FIRMWARE_FONT_EXACT);
      description += `\n${PROGRAM_CARD_FIRMWARE_TEXT_GUIDE}`;
    }
    if (op === "write" && lookOffered()) description += `\n${PROGRAM_CARD_LOOK_POINTER}`;

    if (op === "write" && has(PROGRAM_CARD_ACTIONS_CAPABILITY)) description += `\n${PROGRAM_CARD_ACTIONS_GUIDE}`;

    if (op === "write" && has(PROGRAM_CARD_PICTURES_CAPABILITY)) description += `\n${programCardPicturesGuide(has(PROGRAM_CARD_MODELS_3D_CAPABILITY))}`;
    if (op === "command" && !lookOffered() && has(PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY)) description += `\n${PROGRAM_CARD_LIVE_CAPTURE_GUIDE}`;
    return description;
  }

  api.registerTool(
    (ctx     ) => {
      const factorySessionKey = resolveToolSessionKey(ctx, service);
      if (isEvenAiAgentSession(factorySessionKey, resolveDedicatedEvenAiSessionKey(service))) {
        return null;
      }
      if (
        typeof service.hasConnectedAppClientCapability !== "function" ||
        service.hasConnectedAppClientCapability(PROGRAM_CARD_CAPABILITY) !== true
      ) {
        return null;
      }
      return {
        name: WRITE_GLASSES_CARD_TOOL_NAME,
        description: toolDescription(WRITE_GLASSES_CARD_TOOL_DESCRIPTION, "write"),
        parameters: programCardParametersSchema,
        async execute(toolCallId     , params     ) {

          const refused = typeof askGate === "function" ? askGate(factorySessionKey) : null;
          if (refused) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: refused }) }] };
          const plan = typeof askPlan === "function" ? askPlan(factorySessionKey) : null;
          const game = typeof askGame === "function" ? askGame(factorySessionKey) : null;
          const { images = [], imageReport, ...result } = await handler.writeCard(params, { sessionKey: factorySessionKey,
            imageModel: currentImageModel(ctx, factorySessionKey), ...(plan ? { plan } : {}), ...(typeof game === "boolean" ? { game } : {}) });
          if (result && (result.ok === true || result.persisted === true) && onCardWritten) onCardWritten(factorySessionKey);

          const fromCode = images.length && isCodeModeNestedToolCallId(toolCallId) ? { picturesFromCode: PROGRAM_CARD_LOOK_CODE_PICTURES } : {};
          return { content: [{ type: "text", text: JSON.stringify({ ...fromCode, ...result }) },
            ...(images.length ? lookToolImageContent(imageReport ?? result.firstLook?.report, images) : [])] };
        },
      };
    },
    { name: WRITE_GLASSES_CARD_TOOL_NAME },
  );

  for (const [name, description, parameters, op] of [
    [GLASSES_CARD_COMMAND_TOOL_NAME, GLASSES_CARD_COMMAND_TOOL_DESCRIPTION, glassesCardCommandParametersSchema, "command"],
    [EDIT_GLASSES_CARD_TOOL_NAME, EDIT_GLASSES_CARD_TOOL_DESCRIPTION, editGlassesCardParametersSchema, "edit"],
  ]         ) {
    api.registerTool(
      (ctx     ) => {
        const factorySessionKey = resolveToolSessionKey(ctx, service);
        if (isEvenAiAgentSession(factorySessionKey, resolveDedicatedEvenAiSessionKey(service))) return null;
        if (
          typeof service.hasConnectedAppClientCapability !== "function" ||
          service.hasConnectedAppClientCapability(PROGRAM_CARD_CAPABILITY) !== true
        ) {
          return null;
        }
        return {
          name,
          description: toolDescription(description, op),
          parameters,
          async execute(toolCallId     , params     ) {
            const { images = [], imageReport, ...result } = await handler.talk(op, params, { sessionKey: factorySessionKey,
              ...(op === "command" && params?.capture === true ? { imageModel: currentImageModel(ctx, factorySessionKey) } : {}) });

            if (result?.fixedRefusedWrite === true && (result.ok === true || result.persisted === true) && onCardWritten) onCardWritten(factorySessionKey);
            const fromCode = images.length && isCodeModeNestedToolCallId(toolCallId) ? { picturesFromCode: PROGRAM_CARD_LOOK_CODE_PICTURES } : {};
            return { content: [{ type: "text", text: JSON.stringify({ ...fromCode, ...lookResultForModel(result) }) },
              ...lookToolImageContent(result.capture ?? imageReport ?? result.firstLook?.report, images)] };
          },
        };
      },
      { name },
    );
  }

  const requestWrite = createRequestCardMcpWriteHandler({
    considerWrite: (params     ) => typeof service.considerProgramCardMcpWrite === "function"
      ? service.considerProgramCardMcpWrite(params) : { answer: "off" },
  });
  api.registerTool((ctx     ) => {
    const sessionKey = resolveToolSessionKey(ctx, service);
    if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey(service)) ||
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_CAPABILITY) !== true ||
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_MCP_CAPABILITY) !== true) return null;
    return {
      name: REQUEST_CARD_MCP_WRITE_TOOL_NAME,
      description: REQUEST_CARD_MCP_WRITE_TOOL_DESCRIPTION,
      parameters: requestCardMcpWriteParametersSchema,
      async execute(_toolCallId     , params     ) {
        return { content: [{ type: "text", text: JSON.stringify(await requestWrite(sessionKey, params)) }] };
      },
    };
  }, { name: REQUEST_CARD_MCP_WRITE_TOOL_NAME });

  const requestHostCommand = createRequestHostCommandHandler({
    considerHostCommand: (params     ) => typeof service.considerProgramCardHostCommand === "function"
      ? service.considerProgramCardHostCommand(params) : { answer: "off" },
  });
  api.registerTool((ctx     ) => {
    const sessionKey = resolveToolSessionKey(ctx, service);
    if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey(service)) ||
      service.programCardHostCommandsOn?.() !== true ||
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_CAPABILITY) !== true ||
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_MCP_CAPABILITY) !== true) return null;
    return {
      name: REQUEST_HOST_COMMAND_TOOL_NAME,
      description: REQUEST_HOST_COMMAND_TOOL_DESCRIPTION,
      parameters: requestHostCommandParametersSchema,
      async execute(_toolCallId     , params     ) {
        return { content: [{ type: "text", text: JSON.stringify(await requestHostCommand(sessionKey, params)) }] };
      },
    };
  }, { name: REQUEST_HOST_COMMAND_TOOL_NAME });

  const requestCardSetup = createRequestCardSetupHandler({
    considerSetup: (params     ) => typeof service.considerProgramCardSetup === "function"
      ? service.considerProgramCardSetup(params) : { answer: "no_glasses" },
    getOpenCard: (sessionKey        ) => record.openCards.get(sessionKey),
  });
  api.registerTool((ctx     ) => {
    const sessionKey = resolveToolSessionKey(ctx, service);
    if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey(service)) ||
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_CAPABILITY) !== true) return null;
    return {
      name: REQUEST_CARD_SETUP_TOOL_NAME,
      description: REQUEST_CARD_SETUP_TOOL_DESCRIPTION,
      parameters: requestCardSetupParametersSchema,
      async execute(_toolCallId     , params     ) {
        return { content: [{ type: "text", text: JSON.stringify(await requestCardSetup(sessionKey, params)) }] };
      },
    };
  }, { name: REQUEST_CARD_SETUP_TOOL_NAME });

  api.registerTool((ctx     ) => {
    const sessionKey = resolveToolSessionKey(ctx, service);
    if (isEvenAiAgentSession(sessionKey, resolveDedicatedEvenAiSessionKey(service)) ||
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_CAPABILITY) !== true ||
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_CAPABILITY) !== true &&
      service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_DRIVE_CAPABILITY) !== true) return null;
    return {
      name: LOOK_GLASSES_CARD_TOOL_NAME,
      description: `Test the open card on an isolated copy. ${PROGRAM_CARD_LOOK_GUIDE}${service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LOOK_DRIVE_CAPABILITY) === true ? PROGRAM_CARD_LOOK_DRIVE_GUIDE : ""}${service.hasConnectedAppClientCapability?.(PROGRAM_CARD_LIVE_CAPTURE_CAPABILITY) === true ? PROGRAM_CARD_LIVE_CAPTURE_GUIDE : ""}`,
      parameters: lookGlassesCardParametersSchema,
      async execute(toolCallId     , params     ) {
        const imageModel = currentImageModel(ctx, sessionKey);
        const { images = [], imageReport, aggregateReport: _aggregateReport, ...result } = await handler.lookCard(params, { sessionKey, imageModel });

        const fromCode = images.length && isCodeModeNestedToolCallId(toolCallId) ? { picturesFromCode: PROGRAM_CARD_LOOK_CODE_PICTURES } : {};
        return { content: [{ type: "text", text: JSON.stringify({ ...fromCode, ...lookResultForModel(result) }) }, ...lookToolImageContent(imageReport ?? result.report ?? result.capture, images)] };
      },
    };
  }, { name: LOOK_GLASSES_CARD_TOOL_NAME });
  api.registerTool((ctx     ) => {
    const key = resolveToolSessionKey(ctx, service);
    if (isEvenAiAgentSession(key, resolveDedicatedEvenAiSessionKey(service)) || typeof service.programCardDraftAction !== "function") return null;
    return { name: PROGRAM_CARD_DRAFT_TOOL, description: PROGRAM_CARD_DRAFT_DESCRIPTION, parameters: programCardDraftParametersSchema,
      execute: async (_id     , params     ) => ({ content: [{ type: "text", text: JSON.stringify(await service.programCardDraftAction(key, params)) }] }) };
  }, { name: PROGRAM_CARD_DRAFT_TOOL });

  if (typeof api.on === "function") {

    api.on("llm_input", (event     , ctx     ) => {
      const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey : null;
      if (!sessionKey || typeof event?.provider !== "string" || typeof event?.model !== "string") return;
      record.modelContexts.delete(sessionKey);
      if (record.modelContexts.size >= 64) record.modelContexts.delete(record.modelContexts.keys().next().value);
      record.modelContexts.set(sessionKey, { provider: event.provider, modelId: event.model });
    });

    const openCardHook = createOpenCardHook(record.openCards, { doneSaves: (key        , card     ) =>
      programCardDoneSaves(service, key, card),

      playbookFile: bundledCardFixPlaybookFile(),
      health: (card     , sessionKey        ) => service.programCardHealth?.(card.key, sessionKey),

      feedHealth: (card     , sessionKey        ) => service.programCardFeedHealth?.(card.cardId, card.key, sessionKey) });
    api.on("before_prompt_build", (event     , ctx     ) => {
      const sessionKey = resolveToolSessionKey(ctx, service);
      if (ctx?.modelId && ctx?.modelProviderId) record.modelContexts.set(sessionKey, { modelId: ctx.modelId, provider: ctx.modelProviderId });
      const open = openCardHook(event, ctx);
      const cardsOn =
        typeof service.hasConnectedAppClientCapability === "function" &&
        service.hasConnectedAppClientCapability(PROGRAM_CARD_CAPABILITY) === true &&
        !isEvenAiAgentSession(resolveToolSessionKey(ctx, service), resolveDedicatedEvenAiSessionKey(service));
      const jevOn = cardsOn && typeof service.programCardJevTaught === "function" && service.programCardJevTaught() === true;

      const mcpLines = cardsOn && typeof service.programCardMcpTools === "function" ? programCardMcpOnLines(service.programCardMcpTools()) : "";

      const hostLine = cardsOn && service.programCardHostCommandsOn?.() === true &&
        service.hasConnectedAppClientCapability?.(PROGRAM_CARD_MCP_CAPABILITY) === true ? PROGRAM_CARD_HOST_COMMANDS_ON_LINE : "";

      const drafts = !isEvenAiAgentSession(resolveToolSessionKey(ctx, service), resolveDedicatedEvenAiSessionKey(service)) &&
        typeof service.programCardDraftIndex === "function" ? service.programCardDraftIndex(resolveToolSessionKey(ctx, service)) : "";

      const lines = [cardsOn ? PROGRAM_CARD_WHEN : "",jevOn ? PROGRAM_CARD_JEV_ON_LINE : "", mcpLines, hostLine, drafts].filter(Boolean);

      if (cardsOn && service.hasConnectedAppClientCapability?.(PROGRAM_CARD_ACTIONS_CAPABILITY) === true) lines.push(PROGRAM_CARD_ACTIONS_ON_LINE);

      const changeLine = cardsOn && typeof service.programCardChangeLine === "function" ? service.programCardChangeLine(sessionKey) : "";
      if (changeLine) lines.push(changeLine);

      const checkTurn = { run: typeof ctx?.runId === "string" ? ctx.runId : "",
        texts: [event?.prompt, event?.currentUserMessage].filter((t     ) => typeof t === "string") };

      const openBelow = open ? record.openCards.get(typeof ctx?.sessionKey === "string" ? ctx.sessionKey : "") : null;
      const checkAsk = cardsOn ? programCardCheckAskOf(service, sessionKey, openBelow, Date.now(),
        { host: "openclaw", playbookFile: bundledCardFixPlaybookFile(), turn: checkTurn }) : "";
      if (checkAsk) lines.push(checkAsk);
      if (!lines.length) return open;
      const head = lines.join("\n\n");
      return { prependContext: open ? `${head}\n\n${open.prependContext}` : head };
    });
  }

  if (typeof api.on === "function") {
    api.on("agent_end", (_event     , ctx     ) => {
      const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
      if (sessionKey) { handler.drainSession(sessionKey, { error: "aborted" }); record.modelContexts.delete(sessionKey); }
    });
  }

  let disposed = false;
  return function dispose() {
    if (disposed) return;
    disposed = true;
    record.refs -= 1;
    if (record.refs > 0) return;
    handler.dispose();
    handler.drainAll({ error: "aborted" });
    if (scopeHost[HANDLER_SCOPE_SYMBOL] === record) delete scopeHost[HANDLER_SCOPE_SYMBOL];
  };
}

module.exports = { LOOK_GLASSES_CARD_TOOL_NAME, lookGlassesCardParametersSchema, PROGRAM_CARD_CAPABILITY, WRITE_GLASSES_CARD_TOOL_NAME, GLASSES_CARD_COMMAND_TOOL_NAME, EDIT_GLASSES_CARD_TOOL_NAME, DEFAULT_PROGRAM_CARD_TIMEOUT_MS, PROGRAM_CARD_LIMITS, programCardParametersSchema, PROGRAM_CARD_WHEN, PROGRAM_CARD_JEV_RESULT_LINE, PROGRAM_CARD_MCP_RESULT_LINE, PROGRAM_CARD_MODEL_RESULT_LINE, WRITE_GLASSES_CARD_TOOL_DESCRIPTION, glassesCardCommandParametersSchema, GLASSES_CARD_COMMAND_TOOL_DESCRIPTION, editGlassesCardParametersSchema, EDIT_GLASSES_CARD_TOOL_DESCRIPTION, PROGRAM_CARD_LOOK_CLOSED_NEXT, PROGRAM_CARD_EDIT_CLOSED_NEXT, DRIVE_REPEATED_NEXT, driveNext, validateCardCommandInput, PROGRAM_CARD_EDIT_VERDICTS_RETIRED, validateCardEditInput, validateProgramCardInput, createPendingProgramCardMap, PROGRAM_CARD_OPEN_NOTE_NEXT, PROGRAM_CARD_READY_NOT_SHOWN, PROGRAM_CARD_READY_NEXT, PROGRAM_CARD_READY_WAIT_NEXT, PROGRAM_CARD_CLIENT_RETURN_WAIT_MS, PROGRAM_CARD_CLIENT_RETURN_RECENT_MS, PROGRAM_CARD_CLIENT_RETURN_SETTLE_MS, PROGRAM_CARD_CLIENT_RETURN_LINK_MS, PROGRAM_CARD_NO_CLIENT_NEXT, PROGRAM_CARD_FIRST_LOOK_OPEN_WAIT_MS, PROGRAM_CARD_FRAME_DONE_HOLD_MS, PROGRAM_CARD_TEST_DONE_NEXT, PROGRAM_CARD_FIRST_TEST_NOTE, programCardTestUncoveredNext, PROGRAM_CARD_OPEN_FINDINGS_SENT_MAX, programCardOpenFindingsNote, programCardTestProblemsNext, PROGRAM_CARD_FIRST_LOOK_CLEAN_UNTESTED_NEXT, PROGRAM_CARD_FRAME_DRAWING_NOTE, PROGRAM_CARD_FRAME_CANNOT_LEAD, programCardFrameCannotNote, programCardTestNotCountedNext, PROGRAM_CARD_LOOK_LIMIT_NEXT, PROGRAM_CARD_FIRST_LOOK_CLEAN_DONE_NEXT, PROGRAM_CARD_FIRST_LOOK_CLEAN_DONE_STUDIO_NEXT, PROGRAM_CARD_BUILD_DONE_ERROR, PROGRAM_CARD_BUILD_DONE_NEXT, PROGRAM_CARD_ADVISORY_LOOK_CODES_ENV, PROGRAM_CARD_ADVISORY_LOOK_CODES, programCardAdvisoryLookCodesOn, PROGRAM_CARD_FIRST_LOOK_ADVICE_NOTE, PROGRAM_CARD_FIRST_LOOK_PROBLEMS_NEXT, PROGRAM_CARD_FIRST_LOOK_FAILED_NEXT, PROGRAM_CARD_DRIVE_FAILED_NEXT, PROGRAM_CARD_DRIVE_TIMEOUT_NEXT, PROGRAM_CARD_LOOK_TIMEOUT_NEXT, PROGRAM_CARD_DRIVE_RESUMED_NEXT, PROGRAM_CARD_STOP_NOTHING_LIVE_NEXT, PROGRAM_CARD_STOP_IGNORED_NOTE, PROGRAM_CARD_LOOK_CALL_BUDGET_MS, PROGRAM_CARD_LOOK_AUTO_DRIVE_MAX_CALLS, PROGRAM_CARD_LOOK_CALL_STRETCH_MS, PROGRAM_CARD_LOOK_PHONE_LIMIT_MS, PROGRAM_CARD_LOOK_TOO_LONG_NEXT, programCardLookPaceScale, programCardLookPace, programCardLookStepCostMs, programCardLookAutoDrive, programCardLookBatches, programCardLookTooLongMs, programCardLookStartMs, programCardLookJoinReports, PROGRAM_CARD_LOOK_PLAY_ON_BY_MS, programCardLookPlayLeft, programCardLookUnsplit, PROGRAM_CARD_LOOK_NEXT, PROGRAM_CARD_LOOK_AUTO_DRIVE_NOTE, PROGRAM_CARD_LOOK_DRIVE_SPLIT_NOTE, PROGRAM_CARD_LOOK_PLAY_ON_NOTE, PROGRAM_CARD_LOOK_FAILED_NEXT, programCardLookPhoneResult, createProgramCardToolHandler, resolveToolSessionKey, prepareProgramCardFrameIdea, registerProgramCardTool };
