const { validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");

const TASK_SLOT_FIRST = "task";

const TASK_SLOT_NAME_RE = /^task(_[a-z][a-z0-9_]{0,18})?$/;

const TASK_SLOTS_MAX = 3;

const TASK_SLOTS_CAP_DEFAULT = 3;

const TASK_SLOTS_DATA_MAX = 12000;

const TASK_SLOT_FACTS_MAX = 8000;
const LABEL_MAX_CHARS = 40;
const INPUTS_MAX = 8;

const plain = (v     ) => !!v && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function validTaskSlotName(name         )                 {
  return typeof name === "string" && TASK_SLOT_NAME_RE.test(name);
}

function taskSlotsCap(value         )         {
  return Number.isSafeInteger(value) && (value          ) >= 1 && (value          ) <= TASK_SLOTS_MAX
    ? value           : TASK_SLOTS_CAP_DEFAULT;
}

function printableLabel(value         ) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > LABEL_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function normalizeTaskSlots(raw         , cap         = TASK_SLOTS_MAX)               {
  const most = Math.min(TASK_SLOTS_MAX, Number.isSafeInteger(cap) && cap >= 1 ? cap : TASK_SLOTS_MAX);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > most) return null;
  const out        = [];
  const names = new Set        ();
  let total = 0;
  for (const entry of raw) {
    if (!plain(entry) || Object.keys(entry).some(key => !["name", "label", "inputs", "maxBytes"].includes(key))) return null;
    if (!validTaskSlotName(entry.name) || names.has(entry.name)) return null;
    if (out.length === 0 && entry.name !== TASK_SLOT_FIRST) return null;
    const label = printableLabel(entry.label);
    if (!label) return null;
    const inputs = validateLiveUiInputs(entry.inputs);
    if (!inputs.ok || inputs.inputs.length < 1 || inputs.inputs.length > INPUTS_MAX) return null;
    if (!Number.isSafeInteger(entry.maxBytes) || entry.maxBytes < 1) return null;
    total += entry.maxBytes;
    if (total > TASK_SLOTS_DATA_MAX) return null;
    names.add(entry.name);
    out.push({ name: entry.name, label, inputs: inputs.inputs, maxBytes: entry.maxBytes });
  }
  return out;
}

function cardTaskSlots(record     , inputs               = null)               {
  const stored = record && Array.isArray(record.taskSlots) ? normalizeTaskSlots(record.taskSlots) : null;
  if (stored) return stored;
  if (!Array.isArray(inputs) || !inputs.length) return null;
  const label = printableLabel(record?.name) || "Task";
  return [{ name: TASK_SLOT_FIRST, label, inputs: inputs.map((entry     ) => ({ ...entry })), maxBytes: TASK_SLOTS_DATA_MAX }];
}

function bindingSlot(binding     )         {
  return binding && validTaskSlotName(binding.slot) ? binding.slot : TASK_SLOT_FIRST;
}

const PROGRAM_CARD_TASK_SLOTS_CAPABILITY = "programCardsTaskSlotsV1";

module.exports = { TASK_SLOT_FIRST, TASK_SLOT_NAME_RE, TASK_SLOTS_MAX, TASK_SLOTS_CAP_DEFAULT, TASK_SLOTS_DATA_MAX, TASK_SLOT_FACTS_MAX, validTaskSlotName, taskSlotsCap, normalizeTaskSlots, cardTaskSlots, bindingSlot, PROGRAM_CARD_TASK_SLOTS_CAPABILITY };
