const { compileStoredSurfaceRecords } = require("./liveui-compiler/stored-surface.cjs");
const { validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");

const CARD_SCHEMA_VERSION = 2;

const CARDS                                   = Object.freeze([
  {

    templateId: "ocuclaw.agenda",
    name: "Agenda",
    records: [
      '<ui frame="stack" title="Agenda"/>',
      '<ui id="events" c="list" in="top" cols="time,title,where" rows="data.events"/>',
      '<ui id="facts" c="facts" in="bottom">',
      "Where|=sel.where",
      "Weather|=data.weather",
      "Urgent|=data.urgent",
      "</ui>",
    ].join("\n"),
    inputs: [
      { key: "events", type: "list", label: "Events", maxItems: 20, fields: { time: "text", title: "text", where: "text" } },
      { key: "weather", type: "text", label: "Weather", maxBytes: 64 },
      { key: "urgent", type: "text", label: "Urgent", maxBytes: 64 },
    ],
  },
  {

    templateId: "ocuclaw.digest",
    name: "Digest",
    records: [
      '<ui frame="stack" title="Digest"/>',
      '<ui id="items" c="list" in="top" cols="label,tag,detail" rows="data.items"/>',
      '<ui id="more" c="text" in="bottom" text="=sel.detail"/>',
    ].join("\n"),
    inputs: [
      { key: "items", type: "list", label: "Items", maxItems: 20, fields: { label: "text", tag: "text", detail: "text" } },
    ],
  },
  {
    templateId: "ocuclaw.checklist",
    name: "Checklist",
    records: [
      '<ui frame="full" title="Checklist"/>',
      '<ui id="items" c="checklist" in="main" rows="data.items"/>',
    ].join("\n"),
    inputs: [{ key: "items", type: "list", label: "Items", maxItems: 20, of: "text" }],
  },
  {
    templateId: "ocuclaw.one-line",
    name: "One line",
    records: [
      '<ui frame="full" title="One line"/>',
      '<ui id="line" c="text" in="main" text="=data.line"/>',
    ].join("\n"),
    inputs: [{ key: "line", type: "text", label: "Line", maxBytes: 280 }],
  },
]);

const CARDS_BY_ID = new Map(CARDS.map((card) => [card.templateId, card]));
const RECORD_INPUTS = new Map                                 ();

const OCUCLAW_CARD_IDS                    = Object.freeze(CARDS.map((card) => card.templateId));

function isOcuclawCardId(templateId         )          {
  return typeof templateId === "string" && CARDS_BY_ID.has(templateId);
}

function ocuclawCardDigestInput(templateId         )                                 {
  if (typeof templateId !== "string") return null;
  const card = CARDS_BY_ID.get(templateId);
  if (!card) return null;
  const cached = RECORD_INPUTS.get(templateId);
  if (cached) return JSON.parse(JSON.stringify(cached));
  const inputs = validateLiveUiInputs(card.inputs);
  if (!inputs.ok) throw new Error(`OcuClaw card ${templateId}: ${inputs.message}`);
  const compiled = compileStoredSurfaceRecords(card.records, { inputs: inputs.inputs });
  if (!compiled.ok) throw new Error(`OcuClaw card ${templateId}: ${compiled.code} ${compiled.detail}`);
  const record = {
    schemaVersion: CARD_SCHEMA_VERSION,
    templateId: card.templateId,
    name: card.name,
    vocab: compiled.vocab,
    body: { surface: compiled.surface },
    inputs: inputs.inputs,
  };
  RECORD_INPUTS.set(templateId, record);
  return JSON.parse(JSON.stringify(record));
}

module.exports = { OCUCLAW_CARD_IDS, isOcuclawCardId, ocuclawCardDigestInput };
