const { liveuiLibraryDigest, PROGRAM_CARD_SOURCE_MAX } = require("./glasses-ui-library.cjs");
const { validateLiveUiInputs, checkLiveUiInputValue } = require("./liveui-compiler/template-inputs.cjs");

const { compileStoredSurfaceRecords } = require("./liveui-compiler/stored-surface.cjs");

const TASK_PRESENTATION_VERSION = 1;

const TASK_PRESENTATION_SOURCE_MAX = 16000;
const TASK_PRESENTATION_DATA_MAX = 12000;
const LOOKS = new Set(["ONE_LINE", "DIGEST", "AGENDA", "CHECKLIST", "AGENT"]);
const record = (v     ) => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v     , allowed          ) => record(v) && Object.keys(v).every(k => allowed.includes(k));
const bytes = (v     ) => new TextEncoder().encode(JSON.stringify(v)).length;

function taskPresentationData(inputs                       , raw         )                                 {
  if (!record(raw)) return null;
  const value = raw                           ;
  if (Object.keys(value).length !== inputs.length || bytes(value) > TASK_PRESENTATION_DATA_MAX) return null;
  const out                          = {};
  for (const input of inputs) {
    if (!Object.hasOwn(value, input.key)) return null;
    const checked = checkLiveUiInputValue(input, value[input.key]);
    if (!checked.ok) return null;
    out[input.key] = checked.value;
  }
  return out;
}

const USE_NAMES = ["mcp", "feeds", "jev", "model"];
const USE_PATTERNS = [
  /(?:^|[^\w$.])(["'`]?)(mcp|feeds|jev|model)\1\s*:/g,
  /[{,]\s*(mcp|feeds|jev|model)\s*(?=[,}])/g,
  /\.\s*(mcp|feeds|jev|model)\s*=(?!=)/g,
  /\[\s*(["'`])(mcp|feeds|jev|model)\1\s*\]/g,
];

function taskPresentationUses(source         )           {
  if (typeof source !== "string") return [];
  const found = new Set        ();
  for (const pattern of USE_PATTERNS) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
      const name = m.slice(1).find(g => g !== undefined && USE_NAMES.includes(g));
      if (name) found.add(name);
    }
  }
  return USE_NAMES.filter(n => found.has(n));
}

function taskPresentation(raw     , onInvalid                         , opts                         = {})                          {
  const invalid = (code        ) => { onInvalid?.(code); return null; };
  const proposal = opts?.proposal === true;
  if (!record(raw)) return invalid("presentation_object");
  if (raw.kind === "builtin") return keys(raw, ["kind", "look"]) && LOOKS.has(raw.look)
    ? { kind: "builtin", look: raw.look } : invalid("presentation_builtin");
  if (raw.kind !== "program" && raw.kind !== "surface") return invalid("presentation_kind");
  const body = raw.kind === "program" ? "source" : "records";
  const max = proposal ? TASK_PRESENTATION_SOURCE_MAX : PROGRAM_CARD_SOURCE_MAX;
  if (!keys(raw, ["kind", body, "inputs", "sample"]) || typeof raw[body] !== "string" ||
      !raw[body].trim() || raw[body].length > max) return invalid("presentation_source");
  if (proposal && raw.kind === "program" && taskPresentationUses(raw.source).length) return invalid("presentation_uses");
  const contract = validateLiveUiInputs(raw.inputs);

  if (!contract.ok) return invalid(`presentation_${contract.code}`);
  if (contract.inputs.length < 1 || contract.inputs.length > 8) return invalid("presentation_inputs_count");

  if (contract.inputs.some(i => i.type === "image" || Object.values(i.fields || {}).includes("image"))) return invalid("presentation_image");
  const sample = taskPresentationData(contract.inputs, raw.sample);
  if (!sample) return invalid("presentation_sample");
  if (raw.kind === "surface") {
    const compiled = compileStoredSurfaceRecords(raw.records, { inputs: contract.inputs });
    if (!compiled.ok) return invalid("presentation_records");
    return { kind: "surface", records: raw.records, inputs: contract.inputs, sample };
  }
  return { kind: "program", source: raw.source, inputs: contract.inputs, sample };
}

function taskPresentationDigest(presentation                  )         {
  if (presentation.kind === "builtin") return liveuiLibraryDigest(presentation);
  const { sample: _sample, ...definition } = presentation;
  return liveuiLibraryDigest({ version: TASK_PRESENTATION_VERSION, ...definition });
}

const TASK_PRESENTATION_MODEL_CONTRACT = `Choose the simplest presentation that actually fulfils the owner's request. Three built-in starting choices are ONE_LINE (One line), DIGEST (Sections to open) and AGENT (Short briefing). AGENDA and CHECKLIST also exist. These are fixed layouts, not generated code.
For a custom arrangement without local interaction, use kind surface with reusable LiveUI V2 records and declared inputs. The existing compiler validates supported vocabulary; no actions, external refresh, assets, tool calls or new permissions.
For an interface that needs local interaction, navigation, charts or state, use kind program with real JavaScript function BODY receiving ui and returning {init,update,view,wake?}. Never wrap source in markdown. No imports, DOM, fetch, external feeds, Jev, MCP or model declarations: a source with an mcp, feeds, jev or model block is refused. If the owner wants the card itself to read or send with their tools while open, return status unsupported and say to build the card on the glasses. Task work gathers data separately using its existing permissions. The card handles update(state, {type:"data",name:"task",value:{...all declared inputs},at,source},ctx) and keeps interaction state separate from this replacement data snapshot. init must work without data and show Waiting for first update. Null means unavailable; retain timestamps and show stale data honestly. Never fabricate live values in init. The sample object is fictional and is delivered only in phone Preview. Code must never itself schedule or start Task runs.
Custom presentation schema: {kind:"program",source:"function body, max ${TASK_PRESENTATION_SOURCE_MAX} characters",inputs:[{key:"weather",type:"text",label:"Weather",maxBytes:300},{key:"meetings",type:"list",label:"Meetings",maxItems:8,fields:{time:"text",title:"text"}}],sample:{weather:"Fictional: light rain",meetings:[{time:"09:00",title:"Example check-in"}]}}; or {kind:"surface",records:"supported reusable V2 records",inputs:[...],sample:{...}}. Declare 1–8 inputs of text/number/bool/list, each with a short label in the owner's language; each sample/result must contain every key (null for unavailable). The host fits each run's values to these bounds (long text ends in …, a long list keeps its first rows and the event's fixes[key].hidden counts the rest), so put the most important rows first; the card fits them to the screen. Images are not supported in this Task data contract. Do not claim external connections or permissions. Built-in schema: {kind:"builtin",look:"DIGEST"}.
Input keys AND list row field names must match ^[a-z][a-z0-9_]{0,31}$: lowercase snake_case, never camelCase, spaces or hyphens. The key error is reserved. Scalar types are text, number and bool (not string, integer or boolean). Do not declare object, nested objects or arrays of arrays. Text maxBytes is an integer 1–999. A list maxItems is an integer 1–20; use either of:"text"/"number"/"bool" for scalar lists OR fields:{field_name:"text"/"number"/"bool"} for flat rows, never both. List fields map names directly to type strings, not JSON Schema objects. Keep preparation checks and view selection in local program state, not declared Task inputs. Self-check the exact schema and sample against these rules before replying.
The proposal is inert. The owner explicitly previews it on the phone, applies the exact revision to their draft, then separately approves Task creation/scheduling. Never claim it has run, been saved to Library or scheduled.`;

module.exports = { TASK_PRESENTATION_VERSION, TASK_PRESENTATION_SOURCE_MAX, TASK_PRESENTATION_DATA_MAX, taskPresentationData, taskPresentationUses, taskPresentation, taskPresentationDigest, TASK_PRESENTATION_MODEL_CONTRACT };
