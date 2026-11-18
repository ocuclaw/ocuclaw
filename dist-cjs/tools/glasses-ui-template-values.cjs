const nodeFs = require("node:fs");

const path = require("node:path");
const { atomicWriteLiveuiLibraryRecord, isValidLiveuiLibraryItemId, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { checkLiveUiInputValue } = require("./liveui-compiler/template-inputs.cjs");
const { buildTaskUnchecked, fitTaskUncheckedLine, taskUncheckedLine, validTaskUnchecked } = require("./glasses-ui-task-unchecked.cjs");
const { fitTaskValues, validTaskFixes } = require("./glasses-ui-task-fit.cjs");

const LIVEUI_TEMPLATE_VALUES_DIRNAME = "template-values-v1";
const LIVEUI_TEMPLATE_VALUES_SCHEMA_VERSION = 1;

const LIVEUI_TEMPLATE_VALUES_MAX_BYTES = 64 * 1024;

const LIVEUI_TEMPLATE_VALUES_HEADING_MAX = 40;

const TITLE_MAX = 64;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const OCUCLAW_STARTER_LOOKS

   = Object.freeze([
  { blueprintKey: "ocuclaw:glasses-brief", jobName: "Morning brief", templateId: "ocuclaw.agenda" },
]);

function isPlainObject(value         )                               {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function own(obj                         , key        )          {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OWNER_RE = /^(task\.[a-z0-9][a-z0-9._-]{0,63}|job\.[A-Za-z0-9_-]{1,64})$/;

function liveuiTemplateValuesOwner(owner         )                {
  if (!isPlainObject(owner)) return null;
  if (isValidLiveuiLibraryItemId(owner.taskId)) return `task.${owner.taskId}`;
  if (typeof owner.jobId === "string" && JOB_ID_RE.test(owner.jobId)) return `job.${owner.jobId}`;
  return null;
}

function validOwner(owner         )                  {
  return typeof owner === "string" && OWNER_RE.test(owner);
}

function liveuiTemplateValuesPath(libraryRoot         , templateId        , owner                )         {
  const dir = path.join(resolveLiveuiLibraryRoot(libraryRoot), LIVEUI_TEMPLATE_VALUES_DIRNAME);
  return validOwner(owner) ? path.join(dir, templateId, `${owner}.json`) : path.join(dir, `${templateId}.json`);
}

function wellFormed(file         , templateId        )                             {
  if (!isPlainObject(file)) return null;
  if (file.schemaVersion !== LIVEUI_TEMPLATE_VALUES_SCHEMA_VERSION) return null;
  if (file.templateId !== templateId) return null;
  if (typeof file.digest !== "string" || !file.digest) return null;
  if (typeof file.deliveredAtMs !== "number" || !Number.isFinite(file.deliveredAtMs)) return null;
  if (!isPlainObject(file.values)) return null;
  if (file.resultId !== undefined && typeof file.resultId !== "string") return null;
  if (file.heading !== undefined && typeof file.heading !== "string") return null;

  if (file.unchecked !== undefined && !isPlainObject(file.unchecked)) return null;
  if (file.seenAtMs !== undefined && (typeof file.seenAtMs !== "number" || !Number.isFinite(file.seenAtMs))) return null;

  if (file.fixes !== undefined && !isPlainObject(file.fixes)) return null;
  return file;
}

function readValuesFile(fs     , target        , templateId        )                             {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.size > LIVEUI_TEMPLATE_VALUES_MAX_BYTES) return null;
    return wellFormed(JSON.parse(fs.readFileSync(target, "utf8")), templateId);
  } catch (_) {
    return null;
  }
}

function readLiveuiTemplateValues(
  libraryRoot         ,
  templateId         ,
  opts                                      = {},
)                             {
  if (!isValidLiveuiLibraryItemId(templateId)) return null;
  if (opts.owner !== undefined && opts.owner !== null && !validOwner(opts.owner)) return null;
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  try {
    return readValuesFile(fs, liveuiTemplateValuesPath(libraryRoot, templateId          , opts.owner), templateId          );
  } catch (_) {
    return null;
  }
}

function listLiveuiTemplateValues(
  libraryRoot         ,
  templateId         ,
  opts               = {},
)                                                             {
  if (!isValidLiveuiLibraryItemId(templateId)) return [];
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const found                                                             = [];
  try {
    const dir = path.join(resolveLiveuiLibraryRoot(libraryRoot), LIVEUI_TEMPLATE_VALUES_DIRNAME, templateId          );
    let names        = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      names = [];
    }
    for (const name of [...names].sort()) {
      if (typeof name !== "string" || !name.endsWith(".json")) continue;
      const owner = name.slice(0, -5);
      if (!validOwner(owner)) continue;
      const file = readValuesFile(fs, path.join(dir, name), templateId          );
      if (file) found.push({ owner, file });
    }
    const legacy = readLiveuiTemplateValues(libraryRoot, templateId, { fs });
    if (legacy) found.push({ owner: null, file: legacy });
  } catch (_) {

  }
  return found;
}

function findLiveuiTemplateValues(
  libraryRoot         ,
  templateId         ,
  opts                                         = {},
)                             {
  const all = listLiveuiTemplateValues(libraryRoot, templateId, { fs: opts.fs });
  if (typeof opts.resultId === "string" && opts.resultId) {
    const match = all.find((entry) => entry.file.resultId === opts.resultId);
    return match ? match.file : null;
  }
  let newest                             = null;
  for (const entry of all) {
    if (!newest || entry.file.deliveredAtMs > newest.deliveredAtMs) newest = entry.file;
  }
  return newest;
}

function writeLiveuiTemplateValues(
  libraryRoot         ,
  templateId        ,
  file                         ,
  opts                                                                  = {},
) {
  if (!isValidLiveuiLibraryItemId(templateId)) throw new Error("template values need a valid templateId");
  if (opts.owner !== undefined && opts.owner !== null && !validOwner(opts.owner)) {
    throw new Error("template values need a valid owner");
  }
  if (!wellFormed(file, templateId)) throw new Error("template values file is malformed");
  return atomicWriteLiveuiLibraryRecord({
    fs: opts.fs,
    libraryDir: resolveLiveuiLibraryRoot(libraryRoot),
    targetPath: liveuiTemplateValuesPath(libraryRoot, templateId, opts.owner),
    record: file,
    manageLibraryDir: opts.manageLibraryDir,
  });
}

function removeLiveuiTemplateValues(
  libraryRoot         ,
  templateId         ,
  opts                                      = {},
) {
  if (!isValidLiveuiLibraryItemId(templateId)) return { status: "absent" };
  if (opts.owner !== undefined && opts.owner !== null && !validOwner(opts.owner)) return { status: "absent" };
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  try {
    fs.unlinkSync(liveuiTemplateValuesPath(libraryRoot, templateId          , opts.owner));
    return { status: "removed" };
  } catch (err     ) {
    if (err && err.code === "ENOENT") return { status: "absent" };
    throw err;
  }
}

function removeLiveuiTemplateValuesOwner(
  libraryRoot         ,
  owner         ,
  opts               = {},
)           {
  if (!validOwner(owner)) return [];
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const removed           = [];
  let names        = [];
  try {
    names = fs.readdirSync(path.join(resolveLiveuiLibraryRoot(libraryRoot), LIVEUI_TEMPLATE_VALUES_DIRNAME));
  } catch (_) {
    return removed;
  }
  for (const templateId of [...names].sort()) {
    if (!isValidLiveuiLibraryItemId(templateId)) continue;
    try {
      if (removeLiveuiTemplateValues(libraryRoot, templateId, { fs, owner }).status === "removed") {
        removed.push(templateId);
        try {

          fs.rmdirSync(path.join(resolveLiveuiLibraryRoot(libraryRoot), LIVEUI_TEMPLATE_VALUES_DIRNAME, templateId));
        } catch (_) {

        }
      }
    } catch (_) {

    }
  }
  return removed;
}

const TEMPLATE_UNCHECKED_BUDGET_BYTES = LIVEUI_TEMPLATE_VALUES_MAX_BYTES - 4 * 1024;

function checkDeliveredTemplateValues(inputs         , values         ) {
  const declared = (Array.isArray(inputs) ? inputs : []).filter((input) => isPlainObject(input) && typeof input.key === "string");
  const fit                = fitTaskValues(declared       , values, { budgetBytes: TEMPLATE_UNCHECKED_BUDGET_BYTES });
  if (fit.status !== "fitted") {
    return { ok: false         , code: fit.code, detail: fit.code === "card_values_invalid" ? "card values must be an object"
      : "the card values do not fit the card" };
  }
  return { ok: true         , values: fit.values, dropped: fit.extra, fit };
}

function passiveTemplateValues(envelope         , file         )                                 {
  if (!isPlainObject(envelope) || !isPlainObject(file)) return null;
  if (typeof envelope.digest !== "string" || file.digest !== envelope.digest) return null;
  if (!isPlainObject(file.values)) return null;
  const values                          = {};
  for (const input of Array.isArray(envelope.inputs) ? envelope.inputs : []) {
    if (!isPlainObject(input) || typeof input.key !== "string") continue;
    if (!own(file.values, input.key)) continue;
    const checked = checkLiveUiInputValue(input       , file.values[input.key]);
    if (checked.ok) values[input.key] = checked.value;
  }
  return Object.keys(values).length > 0 ? values : null;
}

function deliveredTemplateUnchecked(
  envelope         ,
  values                         ,
  prior         ,
  delivery                                                                                             ,
) {
  const inputs = isPlainObject(envelope) && Array.isArray(envelope.inputs) ? envelope.inputs : [];
  const keys = inputs.filter((input     ) => isPlainObject(input) && typeof input.key === "string").map((input     ) => input.key);
  const usable = isPlainObject(prior) && isPlainObject(envelope) && prior.digest === envelope.digest ? prior : null;
  const priorSeen = usable ? (typeof usable.seenAtMs === "number" ? usable.seenAtMs : usable.deliveredAtMs) : null;
  return buildTaskUnchecked({
    keys,
    values,
    atMs: delivery.deliveredAtMs,
    reasons: delivery.reasons,

    budgetBytes: TEMPLATE_UNCHECKED_BUDGET_BYTES - (Number.isSafeInteger(delivery.fixesBytes) ? delivery.fixesBytes           : 0),
    prior: usable ? {
      values: usable.values,
      atMs: usable.deliveredAtMs,
      unchecked: usable.unchecked,
      same: (typeof delivery.resultId === "string" && delivery.resultId === usable.resultId) ||
        (priorSeen !== null && delivery.deliveredAtMs <= priorSeen),
    } : null,
  });
}

const TEXT_MAX_BYTES = 999;

const LINE_FIELDS = ["title", "label", "text", "name", "line", "detail", "summary"];

function templateUncheckedOpen(
  envelope         ,
  file         ,
  values                         ,
  nowMs         = Date.now(),
)                                                                {
  if (!isPlainObject(envelope) || !isPlainObject(file) || !isPlainObject(file.unchecked)) return { values, titleLine: null };
  const inputs = (Array.isArray(envelope.inputs) ? envelope.inputs : [])
    .filter((input     ) => isPlainObject(input) && typeof input.key === "string" && own(values, input.key) && values[input.key] === null);
  const unchecked = validTaskUnchecked(file.unchecked, inputs.map((input     ) => input.key));
  if (!unchecked) return { values, titleLine: null };
  const seenAtMs = typeof file.seenAtMs === "number" ? file.seenAtMs : file.deliveredAtMs;
  const out                          = { ...values };
  let titleLine                = null;
  for (const input of inputs         ) {
    const entry = unchecked[input.key];
    if (!entry) continue;
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : input.key;
    const line = taskUncheckedLine(entry, { label, seenAtMs, when: (atMs) => liveuiDeliveredWhen(atMs, nowMs) });
    if (input.type === "text") {
      out[input.key] = fitTaskUncheckedLine(line, typeof input.maxBytes === "number" ? input.maxBytes : TEXT_MAX_BYTES);
      continue;
    }
    if (input.type === "list" && (!input.maxItems || input.maxItems >= 1)) {
      if (isPlainObject(input.fields)) {
        const texts = Object.keys(input.fields).filter((name) => input.fields[name] === "text");
        const field = LINE_FIELDS.find((name) => texts.includes(name)) || texts[0];
        if (field) {
          out[input.key] = [{ [field]: fitTaskUncheckedLine(line, TEXT_MAX_BYTES) }];
          continue;
        }
      } else if ((input.of ?? "text") === "text") {
        out[input.key] = [fitTaskUncheckedLine(line, TEXT_MAX_BYTES)];
        continue;
      }
    }
    if (titleLine === null) titleLine = line;
  }
  return { values: out, titleLine };
}

function liveuiUncheckedTitle(line        )         {
  return fitTaskUncheckedLine(line.replace(/\s+/g, " ").trim(), TITLE_MAX);
}

function pad2(n        )         {
  return n < 10 ? `0${n}` : String(n);
}

function liveuiDeliveredWhen(deliveredAtMs        , nowMs         = Date.now())         {
  const at = new Date(deliveredAtMs);
  const now = new Date(nowMs);
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const startOfDay = (d      ) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return clock;
  if (days > 0 && days < 7) return `${WEEKDAYS[at.getDay()]} ${clock}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${clock}`;
}

function liveuiDeliveredTitle(heading         , fallback        , deliveredAtMs        , nowMs         = Date.now())         {
  const when = liveuiDeliveredWhen(deliveredAtMs, nowMs);
  const raw = typeof heading === "string" && heading.trim() ? heading : fallback;
  const room = Math.min(LIVEUI_TEMPLATE_VALUES_HEADING_MAX, TITLE_MAX - when.length - 3);
  const name = Array.from(String(raw).replace(/\s+/g, " ").trim()).slice(0, room).join("").trim();
  return name ? `${name} · ${when}` : when;
}

function ocuclawStarterLookFor(result         )                {
  if (!isPlainObject(result)) return null;
  const key = typeof result.blueprintKey === "string" ? result.blueprintKey : "";
  const name = typeof result.jobName === "string" ? result.jobName.trim().toLowerCase() : "";
  for (const row of OCUCLAW_STARTER_LOOKS) {
    if (key && key === row.blueprintKey) return row.templateId;
  }
  for (const row of OCUCLAW_STARTER_LOOKS) {
    if (name && name === row.jobName.toLowerCase()) return row.templateId;
  }
  return null;
}

function applyTaskResultToTemplateValues(
  result         ,
  opts                                                                                                              ,
) {
  try {
    if (!isPlainObject(result)) return { status: "skipped", reason: "result_invalid" };
    const resolveLook = typeof opts.resolveLook === "function" ? opts.resolveLook : ocuclawStarterLookFor;
    const templateId = resolveLook(result);
    if (typeof templateId !== "string" || !templateId) return { status: "skipped", reason: "no_look" };
    if (result.status !== undefined && result.status !== "ok") {
      return { status: "skipped", reason: "result_failed", templateId };
    }
    const deliveredAtMs = typeof result.createdAtMs === "number" && Number.isFinite(result.createdAtMs)
      ? result.createdAtMs
      : Date.now();
    let taskId                = null;
    try {
      const resolved = typeof opts.resolveTask === "function" ? opts.resolveTask(result) : null;
      taskId = isValidLiveuiLibraryItemId(resolved) ? (resolved          ) : null;
    } catch (_) {
      taskId = null;
    }
    const owner = liveuiTemplateValuesOwner({ taskId, jobId: result.jobId });
    const write = (values         ) => opts.library.writeDeliveredValues(templateId, {
      values,
      deliveredAtMs,
      ...(owner ? { owner } : {}),
      ...(typeof result.id === "string" ? { resultId: result.id } : {}),
      ...(typeof result.jobName === "string" && result.jobName.trim() ? { heading: result.jobName } : {}),

      ...(Array.isArray(result.toolFailures) ? { toolFailures: result.toolFailures } : {}),
    });
    let written = write(result.card);

    const refused = !written || (written.status !== "written" && written.code !== "template_not_found");
    if (refused) written = write({});
    if (written && written.status === "written") {
      return { ...written, resultId: result.id, ...(refused ? { noCard: true } : {}) };
    }
    if (written && written.code === "template_not_found") {
      return { status: "skipped", reason: "look_not_found", templateId };
    }
    opts.library.clearDeliveredValues(templateId, owner);
    return {
      status: "fallback_text",
      templateId,
      code: written && typeof written.code === "string" ? written.code : "card_values_invalid",
      ...(written && typeof written.key === "string" ? { key: written.key } : {}),
    };
  } catch (err     ) {
    return { status: "skipped", reason: "store_failed", detail: err && err.message ? err.message : String(err) };
  }
}

module.exports = { LIVEUI_TEMPLATE_VALUES_DIRNAME, LIVEUI_TEMPLATE_VALUES_SCHEMA_VERSION, LIVEUI_TEMPLATE_VALUES_MAX_BYTES, LIVEUI_TEMPLATE_VALUES_HEADING_MAX, OCUCLAW_STARTER_LOOKS, liveuiTemplateValuesOwner, liveuiTemplateValuesPath, readLiveuiTemplateValues, listLiveuiTemplateValues, findLiveuiTemplateValues, writeLiveuiTemplateValues, removeLiveuiTemplateValues, removeLiveuiTemplateValuesOwner, TEMPLATE_UNCHECKED_BUDGET_BYTES, checkDeliveredTemplateValues, passiveTemplateValues, deliveredTemplateUnchecked, templateUncheckedOpen, liveuiUncheckedTitle, liveuiDeliveredWhen, liveuiDeliveredTitle, ocuclawStarterLookFor, applyTaskResultToTemplateValues };
