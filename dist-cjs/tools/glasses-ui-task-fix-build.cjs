const { fitTaskValues } = require("./glasses-ui-task-fit.cjs");

const TASK_FIX_BUILD_CODES = Object.freeze({
  notOffered: "fix_not_offered",
  noWidening: "fix_no_widening",
  stillUnusable: "fix_still_unusable",
  noRun: "fix_no_kept_run",
  running: "fix_running",
  card: "card_unavailable",
  changed: "card_changed",
});

const TASK_FIX_CHANGES = Object.freeze(["number_to_text", "fields_to_text", "list_to_text"]         );

const record = (v         )                           => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o     , k        ) => Object.prototype.hasOwnProperty.call(o, k);

function taskFixWiden(input     )                                               {
  if (!record(input) || typeof input.key !== "string") return null;
  const base = { key: input.key, ...(typeof input.label === "string" && input.label ? { label: input.label } : {}) };
  if (input.type === "number") return { input: { ...base, type: "text" }, change: "number_to_text" };
  if (input.type !== "list") return null;
  const list = { ...base, type: "list", ...(Number.isSafeInteger(input.maxItems) ? { maxItems: input.maxItems } : {}) };
  if (record(input.fields)) {
    const names = Object.keys(input.fields);
    if (!names.some((name) => input.fields[name] === "number")) return null;
    const fields = Object.fromEntries(names.map((name) => [name, input.fields[name] === "number" ? "text" : input.fields[name]]));
    return { input: { ...list, fields }, change: "fields_to_text" };
  }
  if (input.of === "number") return { input: { ...list, of: "text" }, change: "list_to_text" };
  return null;
}

function taskFixPick(inputs       , fix     , key        ) {
  const kept = record(fix?.kept) && record(fix.kept.card) ? fix.kept : null;
  if (!kept) return { status: "rejected", code: TASK_FIX_BUILD_CODES.noRun }         ;
  const at = Array.isArray(inputs) ? inputs.findIndex((input) => input?.key === key) : -1;
  const widened = at >= 0 ? taskFixWiden(inputs[at]) : null;
  if (!widened) return { status: "rejected", code: TASK_FIX_BUILD_CODES.noWidening }         ;
  const next = inputs.map((input, index) => index === at ? widened.input : input);
  const fitted = fitTaskValues(next, kept.card);
  if (fitted.status !== "fitted" || fitted.unfit.includes(key) || !own(fitted.values, key) || fitted.values[key] === null)
    return { status: "rejected", code: TASK_FIX_BUILD_CODES.stillUnusable }         ;
  return {
    status: "accepted",
    key,
    change: widened.change,
    input: widened.input,
    inputs: next,
    values: fitted.values,
    atMs: kept.atMs,
  }         ;
}

function taskFixLastValues(inputs       , last     )                                 {
  if (!Array.isArray(inputs) || !record(last) || !record(last.values)) return null;
  const raw                          = {};
  for (const input of inputs) {
    if (!record(input) || typeof input.key !== "string") continue;
    let value          = own(last.values, input.key) ? last.values[input.key] : null;
    const unchecked = record(last.unchecked) ? last.unchecked[input.key] : null;
    if ((value === null || value === undefined) && record(unchecked) && own(unchecked, "last")) value = unchecked.last;
    raw[input.key] = value ?? null;
  }
  const fitted = fitTaskValues(inputs, raw);
  if (fitted.status !== "fitted" || Object.values(fitted.values).every((value) => value === null)) return null;
  return fitted.values;
}

function taskFixSavedValues(inputs       , last     , kept     , key        )                                 {
  if (!Array.isArray(inputs) || !record(last) || !record(last.values)) return null;
  const raw                          = {};
  for (const input of inputs) {
    if (!record(input) || typeof input.key !== "string") continue;
    raw[input.key] = own(last.values, input.key) ? last.values[input.key] ?? null : null;
  }
  const newest = record(kept) && record(kept.card) && Number.isSafeInteger(kept.atMs) &&
    (!Number.isSafeInteger(last.atMs) || kept.atMs >= last.atMs);
  if (newest && own(kept.card, key)) raw[key] = kept.card[key] ?? null;
  const fitted = fitTaskValues(inputs, raw);
  return fitted.status === "fitted" ? fitted.values : null;
}

function taskFixLabel(input     , key        )         {
  if (typeof input?.label === "string" && input.label.trim()) return input.label.replace(/\s+/g, " ").trim();
  const words = (typeof key === "string" ? key : "").replace(/_+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "This value";
}

function taskFixClock(atMs        , timeZone                = null)         {
  const date = new Date(Number.isFinite(atMs) ? atMs : 0);
  const clock = (zone               ) => {
    const parts = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      ...(zone ? { timeZone: zone } : {}) }).formatToParts(date);
    const part = (type        ) => parts.find((entry) => entry.type === type)?.value || "00";
    return `${Number(part("hour")) % 24}:${part("minute")}`;
  };
  try {
    return clock(timeZone);
  } catch (_) {
    return clock(null);
  }
}

function taskFixAskWords(fix                                                                             ) {
  const task = (fix.taskName || "Task").replace(/\s+/g, " ").trim().slice(0, 60);
  return {
    question: `Show ${fix.label} as words?`,
    uses: `fixes your ${task} ${taskFixClock(fix.atMs, fix.timeZone || null)} run`,
  };
}

const PROGRAM_CARD_TASK_FIX_GUIDE = `
FIXING A SAVED TASK CARD (taskFix: read this before you change the card)
The owner's saved card taskFix.card couldn't use its value taskFix.key (taskFix.label) on its Task's last runs: the Task sent words where the card wanted taskFix.was. From now on the host sends that value as taskFix.now. The card is open on the glasses as a draft of its saved code (taskFix.draftId): read that code with glasses_card_draft get, then change it with edit_glasses_card. Never write a new card.
- Change only how the card reads and draws taskFix.key, so it shows the value as words, and still shows a number when one comes. Keep every value name, every other value and the rest of the drawing as they are.
- Real result: taskFix.result is the failing run as the card gets it now. It reaches the draft once it is open, and it is the first thing the fix is checked on.
- Never change the Task, its request or its schedule, and add no MCP reads, feeds, Jev or model.
- Card with several parts: when taskFix.part is set, the card shows other Tasks too (taskFix.otherParts). Change only how the taskFix.part section reads and draws taskFix.key. Keep every other part's section and the parts table as they are: the host widens that part's type itself.
- Save: never save it yourself. The owner saves the fix on the glasses.
`;

const CARD_ASK_TASK_FIX_NEXT = " It fixes a saved card: read taskFixGuide and taskFix, and change the open draft with edit_glasses_card.";

const FIX_REFUSED                         = {
  [TASK_FIX_BUILD_CODES.changed]: "The card changed since the fix started. Tell the owner in one line, and build nothing.",
  [TASK_FIX_BUILD_CODES.card]: "The card is no longer in the Library. Tell the owner in one line, and build nothing.",
};

function taskFixHandOff(fix     , opened     , refused                = null, why = "") {
  if (refused || !fix) {
    const code = refused || TASK_FIX_BUILD_CODES.card;
    return { refused: code, next: FIX_REFUSED[code] || FIX_REFUSED[TASK_FIX_BUILD_CODES.card] };
  }
  const was = fix.change === "number_to_text" ? "a number" : fix.change === "list_to_text" ? "a list of numbers" : "numbers in its rows";
  const now = fix.change === "number_to_text" ? "text" : fix.change === "list_to_text" ? "a list of text" : "text in those row fields";
  return {
    card: fix.cardName,
    ...(opened?.draft?.draftId ? { draftId: opened.draft.draftId } : {}),
    ...(opened && opened.ok !== true ? { openError: typeof opened.error === "string" ? opened.error : "draft_unavailable" } : {}),

    ...(opened && opened.ok !== true && why && !opened.draft?.draftId ? { openWhy: why } : {}),
    key: fix.key,
    label: fix.label,
    was,
    now,
    change: fix.change,
    inputs: fix.inputs,
    result: { values: fix.values, atMs: fix.atMs },

    ...(Array.isArray(fix.parts) ? { part: fix.slot, otherParts: fix.parts.filter((entry     ) => !entry.isNew).map((entry     ) => entry.label || entry.name) } : {}),
  };
}

module.exports = { TASK_FIX_BUILD_CODES, TASK_FIX_CHANGES, taskFixWiden, taskFixPick, taskFixLastValues, taskFixSavedValues, taskFixLabel, taskFixClock, taskFixAskWords, PROGRAM_CARD_TASK_FIX_GUIDE, CARD_ASK_TASK_FIX_NEXT, taskFixHandOff };
