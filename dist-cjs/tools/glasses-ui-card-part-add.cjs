const { TASK_SLOTS_DATA_MAX, TASK_SLOT_FIRST, bindingSlot, normalizeTaskSlots, validTaskSlotName } = require("./glasses-ui-task-slots.cjs");

const CARD_PART_ADD_CODES = Object.freeze({
  full: "card_tasks_full",
  missing: "card_unavailable",
  onCard: "task_on_card",
  invalid: "task_slots_invalid",
  notRevision: "card_not_revision",
});

const LABEL_MAX = 40;
const WORD_MAX = 19;

function cardPartName(taskName         , taken                  )         {
  const used = new Set(taken);
  const words = (typeof taskName === "string" ? taskName : "").toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_").replace(/^[_0-9]+|_+$/g, "");
  const base = `task_${(words || "part").slice(0, WORD_MAX).replace(/_+$/, "")}`;
  if (validTaskSlotName(base) && !used.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`;
    const name = `task_${(words || "part").slice(0, WORD_MAX - suffix.length).replace(/_+$/, "")}${suffix}`;
    if (validTaskSlotName(name) && !used.has(name)) return name;
  }
  return `task_part_${used.size + 1}`;
}

function cardPartLabel(taskName         )         {
  const text = (typeof taskName === "string" ? taskName : "").replace(/\s+/g, " ").trim();
  if (!text) return "Task";
  return text.length <= LABEL_MAX ? text : `${text.slice(0, LABEL_MAX - 1).trimEnd()}…`;
}

function addCardPart(table              , taskName         , inputs       , cap        , part                = null) {
  if (!Array.isArray(table) || !table.length) return { status: "rejected", code: CARD_PART_ADD_CODES.missing };
  if (table.length >= cap) return { status: "rejected", code: CARD_PART_ADD_CODES.full };
  const count = table.length + 1;
  const share = Math.floor(TASK_SLOTS_DATA_MAX / count);
  const kept = table.map((entry     ) => ({ name: entry.name, label: entry.label, inputs: entry.inputs.map((input     ) => ({ ...input })),
    maxBytes: Math.min(entry.maxBytes, share) }));
  const used = kept.reduce((sum        , entry     ) => sum + entry.maxBytes, 0);
  const taken = kept.map((entry     ) => entry.name);
  const slot = part && part !== TASK_SLOT_FIRST && validTaskSlotName(part) && !taken.includes(part) ? part : cardPartName(taskName, taken);
  const next = normalizeTaskSlots([...kept, { name: slot, label: cardPartLabel(taskName), inputs, maxBytes: TASK_SLOTS_DATA_MAX - used }], cap);
  return next ? { status: "accepted", table: next, slot } : { status: "rejected", code: CARD_PART_ADD_CODES.invalid };
}

function repinCardParts(store     , cardId        , revision        , sourceHash        , table              ,
  exceptTaskId                = null) {
  const declared = (table && table.length ? table : [{ name: TASK_SLOT_FIRST }]).map((part     ) => part.name);
  const repinned           = [];
  const failed           = [];
  for (const binding of store.forCard(cardId)) {
    if (binding.schemaVersion !== 2 || binding.taskId === exceptTaskId) continue;
    if (binding.revision === revision && binding.sourceHash === sourceHash) continue;
    if (!declared.includes(bindingSlot(binding))) { failed.push(binding.taskId); continue; }

    const bound = store.bind({ ...binding, revision, sourceHash });
    if (bound?.status === "accepted") repinned.push(binding.taskId);
    else failed.push(binding.taskId);
  }
  return { repinned, failed };
}

function followCardParts(store     , cardId        , revision        , sourceHash        , table              ,
  before                                                 ) {
  const parts = table && table.length ? table : [{ name: TASK_SLOT_FIRST }];

  const ordered = (value     )      => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
  const same = (left     , right     ) => JSON.stringify(ordered(left)) === JSON.stringify(ordered(right));
  const followed           = [];
  const stopped           = [];
  for (const binding of store.forCard(cardId)) {
    if (binding.schemaVersion !== 2) continue;
    if (binding.revision === revision && binding.sourceHash === sourceHash) continue;
    const part = parts.find((entry     ) => entry.name === bindingSlot(binding));
    const fed = !!before && binding.revision === before.revision && binding.sourceHash === before.sourceHash;
    if (!fed || !part || (Array.isArray(part.inputs) && !same(part.inputs, binding.inputs))) {
      stopped.push(binding.taskId);
      continue;
    }
    const bound = store.bind({ ...binding, revision, sourceHash });
    if (bound?.status === "accepted") followed.push(binding.taskId);
    else stopped.push(binding.taskId);
  }
  return { followed, stopped };
}

function relinkCardParts(store     , cardId        , revision        , sourceHash        , table       ) {
  const relinked           = [];
  const failed           = [];
  for (const binding of store.forCard(cardId)) {
    if (binding.schemaVersion !== 2) continue;
    const part = table.find((entry     ) => entry.name === bindingSlot(binding));
    if (!part || !Array.isArray(part.inputs)) { failed.push(binding.taskId); continue; }
    const inputs = part.inputs.map((input     ) => ({ ...input }));
    if (binding.revision === revision && binding.sourceHash === sourceHash &&
        JSON.stringify(binding.inputs) === JSON.stringify(inputs)) continue;
    const bound = store.bind({ ...binding, revision, sourceHash, inputs });
    if (bound?.status === "accepted") relinked.push(binding.taskId);
    else failed.push(binding.taskId);
  }
  return { relinked, failed };
}

function linkedCardParts(store     , cardId        )           {
  return [...new Set        (store.forCard(cardId).map((binding     ) => bindingSlot(binding)))];
}

const PROGRAM_CARD_TASK_ADD_GUIDE = `
ADDING A TASK TO A SAVED CARD (taskAdd: read this before you change the card)
The owner is adding the Task in the hand-off to their saved card taskAdd.card as one more part. The card is open on the glasses now as a draft of its saved code (taskAdd.draftId): read that code with glasses_card_draft get, then change it with edit_glasses_card. Never write a new card.
- Parts: each Task fills one part of the card, by name: taskAdd.parts are the parts it has, the first one named "task". Keep their code and the values they read exactly as they are, since those Tasks' jobs are written for them. Add the one new part, taskAdd.part, for the new Task's values.
- Data: a part's values come all at once as update(state, { type: "data", name: <part name>, value: { [value name]: value }, at, source, fixes }). Keep each part's values in state under its own name. Its run facts are ctx.tasks[<part name>] (ctx.task is the first part's).
- Draw every part with its own four views (waiting, unchecked, empty, ok) and its own time, since parts run at different times: a part with no run yet shows its waiting view while the others show their values.
- Hard cases: taskCases also runs cases across parts (one part 26 h old and one fresh, one never run, one with no Task, values arriving the other way round, every part couldn't check, every part at its most). No case may break any part.
- Plan: its uses row names each part's Task; the other parts' results come into this build.
- Save: never save it yourself. The owner saves it from the phone, and every part's Task then shows on it.
`;

const CARD_ASK_TASK_ADD_NEXT = " It adds a part to a saved card: read taskAddGuide and taskAdd, and change the open draft with edit_glasses_card.";

const ADD_REFUSED                         = {
  [CARD_PART_ADD_CODES.full]: "The card already shows the most Tasks a card can. Tell the owner in one line, and build nothing.",
  [CARD_PART_ADD_CODES.missing]: "The card is no longer in the Library. Tell the owner in one line, and build nothing.",
};

function cardPartAddHandOff(plan     , opened     , why = "") {
  if (!plan || plan.status !== "accepted") {
    const code = typeof plan?.code === "string" ? plan.code : CARD_PART_ADD_CODES.missing;
    return { refused: code, next: ADD_REFUSED[code] || ADD_REFUSED[CARD_PART_ADD_CODES.missing] };
  }
  const part = (entry     ) => ({ name: entry.name, label: entry.label, inputs: entry.inputs,
    ...(entry.values ? { values: entry.values, atMs: entry.atMs } : {}) });
  const added = plan.parts.find((entry     ) => entry.isNew);
  return {
    card: plan.card.name,
    ...(opened?.draft?.draftId ? { draftId: opened.draft.draftId } : {}),
    ...(opened && opened.ok !== true ? { openError: typeof opened.error === "string" ? opened.error : "draft_unavailable" } : {}),

    ...(opened && opened.ok !== true && why && !opened.draft?.draftId ? { openWhy: why } : {}),
    parts: plan.parts.filter((entry     ) => !entry.isNew).map(part),
    part: added ? part(added) : { name: plan.slot },
  };
}

module.exports = { CARD_PART_ADD_CODES, cardPartName, cardPartLabel, addCardPart, repinCardParts, followCardParts, relinkCardParts, linkedCardParts, PROGRAM_CARD_TASK_ADD_GUIDE, CARD_ASK_TASK_ADD_NEXT, cardPartAddHandOff };
