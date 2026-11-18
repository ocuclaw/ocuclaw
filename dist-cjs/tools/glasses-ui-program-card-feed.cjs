const nodeFs = require("node:fs");
const path = require("node:path");

const { atomicWriteLiveuiLibraryRecord, isValidLiveuiLibraryItemId, liveuiLibraryDigest, resolveLiveuiLibraryRoot } = require("./glasses-ui-library.cjs");
const { taskScheduleBinding } = require("./glasses-ui-task-schedule.cjs");
const { validateLiveUiInputs } = require("./liveui-compiler/template-inputs.cjs");
const { TASK_PRESENTATION_DATA_MAX, taskPresentationData } = require("./glasses-ui-task-presentation.cjs");
const { TASK_UNCHECKED_BUDGET_BYTES, buildTaskUnchecked, validTaskUnchecked } = require("./glasses-ui-task-unchecked.cjs");
const { fitTaskValues, taskFitLog, taskFitReasons, validTaskFixes } = require("./glasses-ui-task-fit.cjs");
const { createTaskFitStore, taskFitRecordFor } = require("./glasses-ui-task-fit-records.cjs");
const { taskToolReasons } = require("./glasses-ui-task-tool-failures.cjs");
const { TASK_SLOT_FIRST, bindingSlot, cardTaskSlots, validTaskSlotName } = require("./glasses-ui-task-slots.cjs");
const { nextTaskFix, taskFixDone, taskFixDoneOpen, taskFixDue, taskFixLog, taskFixNotNow, taskFixOffer, taskFixStillFails, taskFixTry, validTaskFix } = require("./glasses-ui-task-fix.cjs");
const { taskFixPick } = require("./glasses-ui-task-fix-build.cjs");
const { TASK_KEPT_LOOK_DIR, validTaskKeptLook } = require("./glasses-ui-task-kept-look.cjs");
const { carryUnknownFields } = require("./saved-format.cjs");

const PROGRAM_CARD_OWNER_SAVED_SHAPE             = Object.freeze({
  fields: ["cardId", "ownerScope", "partsEmptiedAtMs", "taskBuiltAtMs"],
});
const PROGRAM_CARD_STARTER_SAVED_SHAPE             = Object.freeze({
  fields: ["cardId", "starterId", "version", "savedAtMs"],
});

const PROGRAM_CARD_BINDING_SAVED_SHAPE             = Object.freeze({
  fields: ["schemaVersion", "taskId", "cardId", "cardName", "inputs", "boundAtMs", "revision", "sourceHash",
    "taskVersionId", "requestDigest", "ownerScope", "slot", "bindingDigest", "last", "fix", "fixed"],
});

const PROGRAM_CARD_DATA_FRAME = "ocuclaw.program.data";
const PROGRAM_CARD_BINDINGS_FRAME = "ocuclaw.program.bindings";
const PROGRAM_CARD_REFRESH_RESULT_FRAME = "ocuclaw.program.refresh.result";
const PROGRAM_CARD_FEED_OPERATION = "feed_card";

const PROGRAM_CARD_FOLLOW_OWN_CHANGES_ENV = "OCUCLAW_CARD_FOLLOW_OWN_CHANGES";
function programCardFollowsOwnChanges(env      = (globalThis       ).process?.env) {
  return !/^(0|false|off|no)$/i.test(String(env?.[PROGRAM_CARD_FOLLOW_OWN_CHANGES_ENV] ?? "").trim());
}

const BINDINGS_DIR = "program-card-bindings-v1";
const PROPOSALS_DIR = "program-card-link-proposals-v1";
const CARD_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const INPUT_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_INPUTS = 6;
const MAX_LABEL_CHARS = 40;
const MAX_CARD_NAME_CHARS = 60;
const PROGRAM_CARD_VALUE_MAX_CHARS = 120;

function isPlainObject(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function rejected(code     , message      = undefined) {
  return { status: "rejected", code, ...(message ? { message } : {}) };
}

const jsonBytes = (value         ) => new TextEncoder().encode(JSON.stringify(value)).length;

const OWNER_RECORD_MAX_BYTES = 1024;

const QUIET_FEED_SKIPS = new Set(["no_task", "card_not_bound", "already_delivered", "no_feed"]);

function feedCardFromScheduledResult({ result, taskFor, deliver, logger }     ) {
  let taskId      = null;
  try {
    taskId = typeof taskFor === "function" ? taskFor(result) : null;
    if (typeof taskId !== "string" || !taskId) return { status: "skipped", reason: "no_task" };
    if (typeof deliver !== "function") return { status: "skipped", reason: "no_feed" };
    const outcome      = deliver({ taskId, result }) || { status: "skipped", reason: "no_feed" };
    const why = outcome.code || outcome.reason || "unknown";
    const resultId = isPlainObject(result) && typeof result.id === "string" ? result.id : "-";
    if (outcome.status === "delivered") {
      if (Array.isArray(outcome.dropped) && outcome.dropped.length) {
        logger?.info?.(`[program-card] scheduled result fed card=${outcome.cardId} task=${taskId} result=${resultId} dropped=${outcome.dropped.join(",")}`);
      }
    } else if (!QUIET_FEED_SKIPS.has(why)) {
      const log = outcome.status === "rejected" ? logger?.warn : logger?.info;
      log?.call(logger, `[program-card] scheduled result did not reach its card task=${taskId} result=${resultId} status=${outcome.status} code=${why}`);
    }
    return outcome;
  } catch (err     ) {
    logger?.warn?.(`[program-card] scheduled feed failed task=${taskId || "-"}: ${err && err.message ? err.message : err}`);
    return { status: "rejected", code: "feed_failed" };
  }
}

function printableLine(value     , max     ) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return null;

  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

function validateProgramCardBinding(input     , nowMs      = Date.now()) {
  if (!isPlainObject(input)) return rejected("binding_invalid");
  if (input.schemaVersion === 2) return validateSavedProgramBinding(input, nowMs);
  const taskId = input.taskId;
  if (!isValidLiveuiLibraryItemId(taskId)) return rejected("binding_invalid", "taskId");
  const cardId = input.cardId;
  if (typeof cardId !== "string" || !CARD_ID_RE.test(cardId)) return rejected("binding_invalid", "cardId");
  const cardName = printableLine(input.cardName, MAX_CARD_NAME_CHARS) || cardId;
  if (!Array.isArray(input.inputs) || input.inputs.length < 1 || input.inputs.length > MAX_INPUTS) {
    return rejected("binding_invalid", "inputs");
  }
  const inputs        = [];
  const seen = new Set();
  for (const entry of input.inputs) {
    if (!isPlainObject(entry) || typeof entry.key !== "string" || !INPUT_KEY_RE.test(entry.key) || seen.has(entry.key)) {
      return rejected("binding_invalid", "inputs");
    }
    seen.add(entry.key);
    const label = entry.label === undefined || entry.label === null
      ? null
      : printableLine(entry.label, MAX_LABEL_CHARS);
    if (entry.label !== undefined && entry.label !== null && !label) return rejected("binding_invalid", "inputs");
    inputs.push(label && label !== entry.key ? { key: entry.key, label } : { key: entry.key });
  }
  return {
    status: "accepted",
    binding: {
      schemaVersion: 1,
      taskId,
      cardId,
      cardName,
      inputs,
      boundAtMs: Number.isSafeInteger(nowMs) ? nowMs : Date.now(),
    },
  };
}

function validateSavedProgramBinding(input     , nowMs        ) {
  const inputs = validateLiveUiInputs(input.inputs);
  if (!isValidLiveuiLibraryItemId(input.taskId) || !isValidLiveuiLibraryItemId(input.cardId) ||
      !Number.isSafeInteger(input.revision) || input.revision < 1 || !/^sha256:[a-f0-9]{64}$/.test(input.sourceHash || "") ||
      !/^v[1-9][0-9]*$/.test(input.taskVersionId || "") || !/^sha256:[a-f0-9]{64}$/.test(input.requestDigest || "") ||
      !/^sha256:[a-f0-9]{64}$/.test(input.ownerScope || "") ||
      !inputs.ok || inputs.inputs.length < 1 || inputs.inputs.length > 8 ||
      !taskPresentationData(inputs.inputs, Object.fromEntries(inputs.inputs.map(i => [i.key, null])))) return rejected("binding_invalid");

  if (input.slot !== undefined && input.slot !== null && !validTaskSlotName(input.slot)) return rejected("binding_invalid");
  const slot = input.slot === undefined || input.slot === null ? TASK_SLOT_FIRST : input.slot;
  const binding      = { schemaVersion: 2, taskId: input.taskId, cardId: input.cardId,
    cardName: printableLine(input.cardName, 120) || input.cardId, revision: input.revision, sourceHash: input.sourceHash,
    taskVersionId: input.taskVersionId, requestDigest: input.requestDigest, ownerScope: input.ownerScope, inputs: inputs.inputs,
    ...(slot !== TASK_SLOT_FIRST ? { slot } : {}),
    boundAtMs: Number.isSafeInteger(nowMs) ? nowMs : Date.now() };
  binding.bindingDigest = liveuiLibraryDigest({ ...binding, boundAtMs: undefined });
  return { status: "accepted", binding };
}

const PROGRAM_CARD_PROPOSABLE_CARDS                                   = Object.freeze({ feed: "Task feed" });

function programCardKeyFor(name        ) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const lead = /^[a-z]/.test(slug) ? slug : slug ? `v_${slug}` : "value";
  return lead.slice(0, 32).replace(/_+$/, "");
}

function programCardLinkFromAgent(card     ) {
  if (!isPlainObject(card)) return rejected("card_link_invalid", "card must be {cardId, values}");
  for (const key of Object.keys(card)) {
    if (key !== "cardId" && key !== "values") return rejected("card_link_invalid", `unknown card field: ${key}`);
  }
  const cardId = card.cardId === undefined || card.cardId === null ? "feed" : card.cardId;
  if (typeof cardId !== "string" || !Object.prototype.hasOwnProperty.call(PROGRAM_CARD_PROPOSABLE_CARDS, cardId)) {
    return rejected("card_link_invalid", `cardId must be one of: ${Object.keys(PROGRAM_CARD_PROPOSABLE_CARDS).join(", ")}`);
  }
  if (!Array.isArray(card.values) || card.values.length < 1 || card.values.length > MAX_INPUTS) {
    return rejected("card_link_invalid", `values must name 1 to ${MAX_INPUTS} things the card shows`);
  }
  const inputs        = [];
  const used = new Set        ();
  for (const raw of card.values) {
    const label = printableLine(raw, MAX_LABEL_CHARS);
    if (!label) return rejected("card_link_invalid", `each value name must be 1 to ${MAX_LABEL_CHARS} printable characters`);
    const base = programCardKeyFor(label);
    let key = base;
    for (let n = 2; used.has(key); n += 1) key = `${base.slice(0, 32 - `_${n}`.length)}_${n}`;
    used.add(key);
    inputs.push(label !== key ? { key, label } : { key });
  }
  return { status: "accepted", link: { cardId, cardName: PROGRAM_CARD_PROPOSABLE_CARDS[cardId], inputs } };
}

function programCardProposalBoundTo(proposal     , version     ) {
  if (!proposal || !version) return false;
  const binding = taskScheduleBinding(version);
  return proposal.taskVersionId === binding.taskVersionId && proposal.requestDigest === binding.requestDigest;
}

function programCardProposalDigest(proposal     ) {
  return liveuiLibraryDigest({
    taskId: proposal.taskId,
    taskVersionId: proposal.taskVersionId,
    requestDigest: proposal.requestDigest,
    cardId: proposal.cardId,
    cardName: proposal.cardName,
    inputs: proposal.inputs,
  });
}

function checkProgramCardValues(binding     , values     , budgetBytes         = TASK_PRESENTATION_DATA_MAX) {
  if (!binding || !Array.isArray(binding.inputs)) return rejected("card_not_bound");
  if (binding.schemaVersion === 2) {

    const budget = Number.isSafeInteger(budgetBytes) && budgetBytes > 0 && budgetBytes <= TASK_PRESENTATION_DATA_MAX
      ? budgetBytes : TASK_PRESENTATION_DATA_MAX;
    const fit = fitTaskValues(binding.inputs, values, { budgetBytes: budget });
    if (fit.status !== "fitted") return rejected(fit.code);
    return { status: "accepted", values: fit.values, dropped: fit.extra, fit };
  }
  if (!isPlainObject(values)) return rejected("card_values_invalid");
  const declared = new Set(binding.inputs.map((entry     ) => entry.key));
  const accepted      = {};
  const dropped           = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!declared.has(key)) {
      dropped.push(key);
      continue;
    }
    let text      = null;
    if (typeof raw === "string") text = printableLine(raw, PROGRAM_CARD_VALUE_MAX_CHARS);
    else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
    else if (typeof raw === "boolean") text = raw ? "yes" : "no";
    if (text === null) {
      dropped.push(key);
      continue;
    }
    accepted[key] = text;
  }
  if (Object.keys(accepted).length === 0) {
    return { ...rejected("card_values_unfit"), dropped };
  }
  return { status: "accepted", values: accepted, dropped };
}

function formatProgramCardData(delivery     ) {
  return JSON.stringify({
    type: PROGRAM_CARD_DATA_FRAME,
    v: delivery.revision ? 2 : 1,
    taskId: delivery.taskId,
    cardId: delivery.cardId,
    values: delivery.values,
    atMs: delivery.atMs,
    source: delivery.source,
    ...(delivery.revision ? { revision: delivery.revision, sourceHash: delivery.sourceHash, bindingDigest: delivery.bindingDigest } : {}),

    ...(delivery.revision && typeof delivery.slot === "string" ? { slot: delivery.slot } : {}),

    ...(delivery.revision && isPlainObject(delivery.unchecked) ? { unchecked: delivery.unchecked } : {}),

    ...(delivery.revision && isPlainObject(delivery.fixes) ? { fixes: delivery.fixes } : {}),
    ...(delivery.revision && Number.isSafeInteger(delivery.seenAtMs) ? { seenAtMs: delivery.seenAtMs } : {}),
    ...(typeof delivery.runId === "string" ? { runId: delivery.runId } : {}),
    ...(typeof delivery.resultId === "string" ? { resultId: delivery.resultId } : {}),
  });
}

function valuesInInputOrder(binding     ) {
  const values      = {};
  for (const { key } of binding.inputs) {
    if (Object.prototype.hasOwnProperty.call(binding.last.values, key)) values[key] = binding.last.values[key];
  }
  return values;
}

function projectProgramCardBindingForPhone(binding     , state                = null, openUpdate      = null,
  runsWeek      = null, fix      = null, fixState      = null) {
  return {
    taskId: binding.taskId,
    cardId: binding.cardId,
    cardName: binding.cardName,
    inputs: binding.inputs.map((entry     ) => ({ ...entry })),
    ...(binding.schemaVersion === 2 ? { schemaVersion: 2, revision: binding.revision, sourceHash: binding.sourceHash,
      bindingDigest: binding.bindingDigest, slot: bindingSlot(binding) } : {}),

    ...(binding.schemaVersion === 2 && (state === "task_changed" || state === "card_changed" || state === "task_missing")
      ? { stale: state } : {}),
    ...(binding.last && isPlainObject(binding.last.values)
      ? { last: { values: valuesInInputOrder(binding), atMs: binding.last.atMs, source: binding.last.source,

        ...(isPlainObject(binding.last.unchecked) ? { unchecked: binding.last.unchecked } : {}),
        ...(Number.isSafeInteger(binding.last.seenAtMs) ? { seenAtMs: binding.last.seenAtMs } : {}),

        ...(isPlainObject(binding.last.fixes) ? { fixes: binding.last.fixes } : {}) } }
      : {}),

    ...(isPlainObject(openUpdate) ? { openUpdate } : {}),

    ...(isPlainObject(runsWeek) ? { runsWeek } : {}),

    ...(binding.schemaVersion === 2 && isPlainObject(fix) ? { fix } : {}),

    ...(binding.schemaVersion === 2 && isPlainObject(fixState?.fixing) ? { fixing: fixState.fixing } : {}),
    ...(binding.schemaVersion === 2 && isPlainObject(fixState?.done) ? { fixDone: fixState.done } : {}),
  };
}

function projectProgramCardProposalForPhone(proposal     ) {
  return {
    taskId: proposal.taskId,
    taskVersionId: proposal.taskVersionId,
    cardId: proposal.cardId,
    cardName: proposal.cardName,
    inputs: proposal.inputs.map((entry     ) => ({ ...entry })),
    digest: proposal.digest,
  };
}

function formatProgramCardBindings(bindings     , proposals      = [], stateOf                                    = null,
  openUpdateOf                                 = null, cards               = null, runsWeekOf                                 = null,
  fixOf                                 = null, fixStateOf                                 = null) {
  return JSON.stringify({
    type: PROGRAM_CARD_BINDINGS_FRAME,
    v: 1,
    bindings: (Array.isArray(bindings) ? bindings : []).map((binding     ) =>
      projectProgramCardBindingForPhone(binding, stateOf ? stateOf(binding) : null, openUpdateOf ? openUpdateOf(binding) : null,
        runsWeekOf ? runsWeekOf(binding) : null, fixOf ? fixOf(binding) : null, fixStateOf ? fixStateOf(binding) : null)),
    proposals: (Array.isArray(proposals) ? proposals : []).map(projectProgramCardProposalForPhone),

    ...(Array.isArray(cards) ? { cards } : {}),
  });
}

function formatProgramCardRefreshResult(result     ) {
  return JSON.stringify({
    type: PROGRAM_CARD_REFRESH_RESULT_FRAME,
    v: 1,
    cardId: result.cardId,
    taskId: result.taskId || null,
    status: result.status,

    ...(typeof result.slot === "string" ? { slot: result.slot } : {}),
    ...(typeof result.code === "string" ? { code: result.code } : {}),

    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),

    ...(Array.isArray(result.slots) ? { slots: result.slots.filter((part     ) => isPlainObject(part) && validTaskSlotName(part.slot))
      .slice(0, 3).map((part     ) => ({ slot: part.slot, taskId: typeof part.taskId === "string" ? part.taskId : null,
        status: part.status === "accepted" ? "accepted" : "rejected", ...(typeof part.code === "string" ? { code: part.code } : {}) })) } : {}),

    ...(refreshAsk(result.ask) ? { ask: refreshAsk(result.ask) } : {}),
  });
}

function refreshAsk(ask     ) {
  if (!isPlainObject(ask) || typeof ask.card !== "string" || !Array.isArray(ask.tasks)) return null;
  const tasks = ask.tasks.filter((task     ) => isPlainObject(task) && typeof task.taskId === "string" && typeof task.name === "string")
    .slice(0, 3).map((task     ) => ({
      ...(validTaskSlotName(task.slot) ? { slot: task.slot } : {}),
      taskId: task.taskId,
      name: task.name,
      sends: Array.isArray(task.sends) ? task.sends.filter((send     ) => typeof send === "string").slice(0, 2) : [],
    }));
  return tasks.length ? { card: ask.card, tasks } : null;
}

function programCardLook(binding     ) {
  if (!binding) return null;
  if (binding.schemaVersion === 2) return { name: binding.cardName, inputs: binding.inputs,
    digest: binding.bindingDigest, taskPresentation: true };
  const inputs = binding.inputs.map((entry     ) => ({
    key: entry.key,
    type: "text",
    ...(entry.label ? { label: entry.label } : {}),
    maxBytes: PROGRAM_CARD_VALUE_MAX_CHARS,
  }));
  return {
    name: binding.cardName,
    inputs,
    digest: liveuiLibraryDigest({ cardId: binding.cardId, inputs }),
  };
}

function validStoredBinding(record     ) {
  if (!isPlainObject(record) || ![1, 2].includes(record.schemaVersion)) return null;
  const checked      = validateProgramCardBinding(record, record.boundAtMs);
  if (checked.status !== "accepted") return null;
  const binding      = checked.binding;
  if (isPlainObject(record.last) && isPlainObject(record.last.values) && Number.isSafeInteger(record.last.atMs) &&
      (binding.schemaVersion !== 2 || taskPresentationData(binding.inputs, record.last.values))) {
    binding.last = {
      values: { ...record.last.values },
      atMs: record.last.atMs,
      source: record.last.source === "schedule" || record.last.source === "test" ? record.last.source : "run",
      ...(typeof record.last.deliveryId === "string" ? { deliveryId: record.last.deliveryId } : {}),
    };
    if (binding.schemaVersion === 2) {

      const unchecked = validTaskUnchecked(record.last.unchecked,
        binding.inputs.map((entry     ) => entry.key).filter((key        ) => binding.last.values[key] === null));
      if (unchecked) binding.last.unchecked = unchecked;
      if (unchecked && Number.isSafeInteger(record.last.seenAtMs)) binding.last.seenAtMs = record.last.seenAtMs;

      const fixes = validTaskFixes(record.last.fixes, binding.inputs.map((entry     ) => entry.key));
      if (fixes) binding.last.fixes = fixes;
    }
  }

  if (binding.schemaVersion === 2) {
    const fix = validTaskFix(record.fix, binding.inputs.map((entry     ) => entry.key));
    if (fix) binding.fix = fix;

    const fixed = validTaskFixed(record.fixed);
    if (fixed) binding.fixed = fixed;
  }
  return binding;
}

function validTaskFixed(raw     ) {
  if (!isPlainObject(raw) || !Number.isSafeInteger(raw.atMs) || typeof raw.key !== "string" || typeof raw.change !== "string" ||
      !Number.isSafeInteger(raw.toRevision) || !Number.isSafeInteger(raw.revision) || typeof raw.sourceHash !== "string" ||
      !Array.isArray(raw.inputs) || raw.inputs.length > 64 || !raw.inputs.every(isPlainObject)) return null;
  if (raw.last !== undefined && (!isPlainObject(raw.last) || !isPlainObject(raw.last.values))) return null;
  const other = (entry     ) => isPlainObject(entry) && typeof entry.taskId === "string" &&
    Number.isSafeInteger(entry.revision) && typeof entry.sourceHash === "string";
  if (raw.others !== undefined && (!Array.isArray(raw.others) || raw.others.length > 8 || !raw.others.every(other))) return null;
  return {
    atMs: raw.atMs, key: raw.key, change: raw.change, toRevision: raw.toRevision, revision: raw.revision,
    sourceHash: raw.sourceHash, inputs: raw.inputs.map((entry     ) => ({ ...entry })),
    ...(raw.last ? { last: JSON.parse(JSON.stringify(raw.last)) } : {}),
    ...(raw.others?.length ? { others: raw.others.map((entry     ) => ({ taskId: entry.taskId, revision: entry.revision,
      sourceHash: entry.sourceHash })) } : {}),

    ...(Number.isSafeInteger(raw.tries) && raw.tries >= 0 && raw.tries <= 99 ? { tries: raw.tries } : {}),
    ...(Number.isSafeInteger(raw.stillFailsAtMs) && raw.stillFailsAtMs >= 0 ? { stillFailsAtMs: raw.stillFailsAtMs } : {}),
    ...(Number.isSafeInteger(raw.closedAtMs) && raw.closedAtMs >= 0 ? { closedAtMs: raw.closedAtMs } : {}),
  };
}

function validStoredProposal(record     ) {
  if (!isPlainObject(record) || record.schemaVersion !== 1) return null;
  if (typeof record.taskVersionId !== "string" || !record.taskVersionId) return null;
  if (typeof record.requestDigest !== "string" || !record.requestDigest) return null;
  const checked      = validateProgramCardBinding(record, record.proposedAtMs);
  if (checked.status !== "accepted") return null;
  const proposal      = {
    schemaVersion: 1,
    taskId: checked.binding.taskId,
    taskVersionId: record.taskVersionId,
    requestDigest: record.requestDigest,
    cardId: checked.binding.cardId,
    cardName: checked.binding.cardName,
    inputs: checked.binding.inputs,
    authoredBy: record.authoredBy === "phone" ? "phone" : "agent",
    proposedAtMs: checked.binding.boundAtMs,
  };
  proposal.digest = programCardProposalDigest(proposal);
  return proposal;
}

function createProgramCardFeedStore(opts      = {}) {
  const fs = opts.fs && typeof opts.fs === "object" ? opts.fs : nodeFs;
  const libraryDir = resolveLiveuiLibraryRoot(opts.libraryDir);
  const dir = path.join(libraryDir, BINDINGS_DIR);
  const proposalsDir = path.join(libraryDir, PROPOSALS_DIR);
  const ownersDir = path.join(libraryDir, "task-presentation-card-owners-v1");
  const startersDir = path.join(libraryDir, "program-card-starters-v1");
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const fileFor = (taskId     ) => path.join(dir, `${taskId}.json`);

  const fits = createTaskFitStore({ fs, libraryDir });
  const proposalFileFor = (taskId     ) => path.join(proposalsDir, `${taskId}.json`);

  const keptDir = path.join(libraryDir, TASK_KEPT_LOOK_DIR);
  const keptFileFor = (taskId     ) => path.join(keptDir, `${taskId}.json`);

  function cardSlotsOf(cardId        )               {
    if (typeof opts.loadCard !== "function") return null;
    try {
      const card = opts.loadCard(cardId);
      return card?.status === "accepted" && Array.isArray(card.taskSlots) ? cardTaskSlots(card) : null;
    } catch (_) { return null; }
  }
  function ownerRecord(cardId        )      {
    if (!isValidLiveuiLibraryItemId(cardId)) return "unavailable";
    const file = path.join(ownersDir, `${cardId}.json`);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > OWNER_RECORD_MAX_BYTES) return "unavailable";
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      return record && record.cardId === cardId && /^sha256:[a-f0-9]{64}$/.test(record.ownerScope || "") ? record : "unavailable";
    } catch (e     ) { return e.code === "ENOENT" ? null : "unavailable"; }
  }

  function writeOwnerRecord(cardId        , record     , next     ) {
    const carried = carryUnknownFields(record, next, PROGRAM_CARD_OWNER_SAVED_SHAPE);
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: path.join(ownersDir, `${cardId}.json`),
      record: jsonBytes(carried) + 1 <= OWNER_RECORD_MAX_BYTES ? carried : next });
  }
  const ownerStamps = (record     ) => ({
    ...(Number.isSafeInteger(record.partsEmptiedAtMs) ? { partsEmptiedAtMs: record.partsEmptiedAtMs } : {}),
    ...(Number.isSafeInteger(record.taskBuiltAtMs) ? { taskBuiltAtMs: record.taskBuiltAtMs } : {}),
  });
  function ownerScope(cardId        )                {
    const record = ownerRecord(cardId);
    return record && typeof record === "object" ? record.ownerScope : record;
  }

  function markEmptied(cardId        ) {
    const record = ownerRecord(cardId);
    if (!record || typeof record !== "object") return;
    writeOwnerRecord(cardId, record, { cardId, ownerScope: record.ownerScope, ...ownerStamps(record), partsEmptiedAtMs: now() });
  }

  function markTaskBuilt(cardId        ) {
    const record = ownerRecord(cardId);
    if (!record || typeof record !== "object") return false;
    if (Number.isSafeInteger(record.taskBuiltAtMs)) return true;
    return writeOwnerRecord(cardId, record, { cardId, ownerScope: record.ownerScope, ...ownerStamps(record), taskBuiltAtMs: now() })
      .status === "written";
  }

  function markStarter(cardId        , starter                                 ) {
    if (!isValidLiveuiLibraryItemId(cardId) || typeof starter?.id !== "string" || !Number.isSafeInteger(starter?.version)) return false;
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: path.join(startersDir, `${cardId}.json`),
      record: { cardId, starterId: starter.id, version: starter.version, savedAtMs: now() } }).status === "written";
  }

  function cardStarter(cardId        ) {
    if (!isValidLiveuiLibraryItemId(cardId)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(startersDir, `${cardId}.json`), "utf8"));
      return record && record.cardId === cardId && typeof record.starterId === "string" && Number.isSafeInteger(record.version)
        ? { starterId: record.starterId, version: record.version, savedAtMs: record.savedAtMs } : null;
    } catch (_) { return null; }
  }

  function forgetStarter(cardId        ) {
    if (!isValidLiveuiLibraryItemId(cardId)) return;
    try { fs.rmSync(path.join(startersDir, `${cardId}.json`), { force: true }); } catch (_) {  }
  }
  function cardTaskBuilt(cardId        ) {
    const record = typeof cardId === "string" ? ownerRecord(cardId) : null;
    return !!record && typeof record === "object" && Number.isSafeInteger(record.taskBuiltAtMs) && record.taskBuiltAtMs > 0;
  }

  function changeFix(taskId     , change                   ) {
    const binding = read(taskId);
    if (binding?.schemaVersion !== 2) return rejected("card_not_bound");
    const fix = change(binding.fix);
    if (!fix) return rejected("fix_not_offered");
    binding.fix = fix;
    if (write(binding).status !== "written") return rejected("binding_save_failed");
    return { status: "accepted", binding };
  }

  function claimCard(cardId        , scope        ) {
    if (!isValidLiveuiLibraryItemId(cardId) || !/^sha256:[a-f0-9]{64}$/.test(scope || "")) return rejected("binding_invalid");
    const previous = ownerScope(cardId);
    if (previous && previous !== scope) return rejected("presentation_owner_changed");
    if (previous === scope) return { status: "accepted" };
    const written = atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: path.join(ownersDir, `${cardId}.json`),
      record: { cardId, ownerScope: scope } });
    return written.status === "written" ? { status: "accepted" } : rejected("binding_save_failed");
  }

  function sameLink(before     , binding     ) {
    const read = validStoredBinding(before);
    return !!read && read.schemaVersion === binding.schemaVersion && read.taskId === binding.taskId &&
      read.cardId === binding.cardId && bindingSlot(read) === bindingSlot(binding);
  }

  function write(binding     ) {

    const before = readFrom(fileFor(binding.taskId), (raw     ) => raw);
    const record = sameLink(before, binding) ? carryUnknownFields(before, binding, PROGRAM_CARD_BINDING_SAVED_SHAPE) : binding;
    return atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: fileFor(binding.taskId), record });
  }

  function readFrom(file     , validate     ) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (_) {
      return null;
    }
    try {
      return validate(JSON.parse(raw));
    } catch (_) {
      return null;
    }
  }

  function read(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return null;
    return readFrom(fileFor(taskId), validStoredBinding);
  }

  function readProposal(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return null;
    const proposal = readFrom(proposalFileFor(taskId), validStoredProposal);
    return proposal && proposal.taskId === taskId ? proposal : null;
  }

  function listIn(from     , readOne     ) {
    let names           = [];
    try {
      names = fs.readdirSync(from);
    } catch (_) {
      return [];
    }
    const out        = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || name.startsWith(".")) continue;
      const record = readOne(name.slice(0, -".json".length));
      if (record) out.push(record);
    }
    return out;
  }

  const list = () => listIn(dir, read);

  function unlink(file     ) {
    try {
      fs.unlinkSync(file);
    } catch (err     ) {
      if (!err || err.code !== "ENOENT") throw err;
      return { status: "accepted", cleared: false };
    }
    return { status: "accepted", cleared: true };
  }

  function unbind(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return { status: "rejected", code: "binding_invalid" };
    return unlink(fileFor(taskId));
  }

  function clear(taskId     ) {
    if (!isValidLiveuiLibraryItemId(taskId)) return { status: "rejected", code: "binding_invalid" };
    const existing = read(taskId);
    const done      = unbind(taskId);
    if (done.cleared === true && existing?.schemaVersion === 2) markEmptied(existing.cardId);
    return done;
  }

  return {
    dir,
    proposalsDir,
    read,
    list,
    clear,
    ownerScope,
    claimCard,

    partsEmptiedAtMs(cardId     )                {
      const record = typeof cardId === "string" ? ownerRecord(cardId) : null;
      const at = record && typeof record === "object" ? record.partsEmptiedAtMs : null;
      return Number.isSafeInteger(at) && at > 0 ? at : null;
    },

    cardSlots: cardSlotsOf,
    markTaskBuilt,
    cardTaskBuilt,
    markStarter,
    cardStarter,
    forgetStarter,

    fixNotNow(taskId     ) {
      return changeFix(taskId, (fix     ) => taskFixNotNow(fix, now()));
    },

    fixTry(taskId     , check        , counts         ) {
      return changeFix(taskId, (fix     ) => taskFixTry(fix, check, now(), counts === true));
    },

    fixClose(taskId     ) {
      const binding = read(taskId);
      if (binding?.schemaVersion !== 2) return rejected("card_not_bound");
      if (!taskFixDoneOpen(binding.fixed, now())) return rejected("fix_not_offered");
      binding.fixed = { ...binding.fixed, closedAtMs: now() };
      if (write(binding).status !== "written") return rejected("binding_save_failed");
      return { status: "accepted", binding };
    },

    ownedCards()           {
      let names           = [];
      try { names = fs.readdirSync(ownersDir); } catch (_) { return []; }
      return names.filter((name        ) => name.endsWith(".json") && !name.startsWith("."))
        .map((name        ) => name.slice(0, -".json".length)).filter(isValidLiveuiLibraryItemId).sort();
    },

    keepLook(taskId     , cardId     , kept     ) {
      if (!isValidLiveuiLibraryItemId(taskId) || !kept) return false;
      const record = validTaskKeptLook({ schemaVersion: 1, taskId, cardId, look: kept.look, templateId: kept.templateId,
        keptAtMs: now() }, taskId);
      return !!record && atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: keptFileFor(taskId), record })
        .status === "written";
    },

    keptLook(taskId     ) {
      if (!isValidLiveuiLibraryItemId(taskId)) return null;
      return readFrom(keptFileFor(taskId), (record     ) => validTaskKeptLook(record, taskId));
    },

    forgetLook(taskId     ) {
      if (!isValidLiveuiLibraryItemId(taskId)) return { status: "rejected", code: "binding_invalid" };
      return unlink(keptFileFor(taskId));
    },
    readProposal,
    listProposals: () => listIn(proposalsDir, readProposal),
    clearProposal(taskId     ) {
      if (!isValidLiveuiLibraryItemId(taskId)) return { status: "rejected", code: "binding_invalid" };
      return unlink(proposalFileFor(taskId));
    },

    propose(taskId     , version     , link     , options      = {}) {
      if (!version || typeof version.versionId !== "string") return rejected("card_link_invalid", "no Draft to carry the card link");
      const checked      = validateProgramCardBinding({ taskId, ...link }, now());
      if (checked.status !== "accepted") return checked;
      const record      = {
        schemaVersion: 1,
        taskId,
        ...taskScheduleBinding(version),
        cardId: checked.binding.cardId,
        cardName: checked.binding.cardName,
        inputs: checked.binding.inputs,
        authoredBy: options.authoredBy === "phone" ? "phone" : "agent",
        proposedAtMs: checked.binding.boundAtMs,
      };
      atomicWriteLiveuiLibraryRecord({ fs, libraryDir, targetPath: proposalFileFor(taskId), record });
      return { status: "accepted", proposal: { ...record, digest: programCardProposalDigest(record) } };
    },

    forCard(cardId     ) {
      const bound = list().filter((binding) => binding.cardId === cardId);
      if (bound.length < 2) return bound;
      const order = (cardSlotsOf(cardId) || []).map((slot     ) => slot.name);
      const rank = (binding     ) => {
        const at = order.indexOf(bindingSlot(binding));
        return at >= 0 ? at : bindingSlot(binding) === TASK_SLOT_FIRST ? -1 : order.length;
      };
      return bound.sort((a, b) => rank(a) - rank(b) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    },

    clearCard(cardId     ) {
      const cleared           = [];
      for (const binding of list()) {
        if (binding.cardId !== cardId) continue;

        const done      = unbind(binding.taskId);
        if (done.cleared === true) cleared.push(binding.taskId);
      }
      for (const proposal of listIn(proposalsDir, readProposal)) {
        if (proposal.cardId === cardId) unlink(proposalFileFor(proposal.taskId));
      }
      return cleared;
    },

    bind(input     ) {
      const checked      = validateProgramCardBinding(input, now());
      if (checked.status !== "accepted") return checked;
      const slot = bindingSlot(checked.binding);
      if (checked.binding.schemaVersion === 2) {
        const declared = (cardSlotsOf(checked.binding.cardId) || [{ name: TASK_SLOT_FIRST }]).map((entry     ) => entry.name);
        if (!declared.includes(slot)) return rejected("task_slot_undeclared");
        const claimed = claimCard(checked.binding.cardId, checked.binding.ownerScope);
        if (claimed.status !== "accepted") return claimed;
      } else if (ownerScope(checked.binding.cardId)) return rejected("presentation_owner_changed");
      const existing = read(input.taskId);
      if (checked.binding.schemaVersion === 2 && existing?.bindingDigest === checked.binding.bindingDigest)
        return { status: "accepted", binding: existing };
      if (checked.binding.schemaVersion === 2 && existing?.schemaVersion === 2 && existing.cardId === checked.binding.cardId &&
          existing.taskVersionId === checked.binding.taskVersionId && existing.requestDigest === checked.binding.requestDigest &&
          liveuiLibraryDigest(existing.inputs) === liveuiLibraryDigest(checked.binding.inputs) && existing.last) {
        checked.binding.last = existing.last;

        if (existing.fix) checked.binding.fix = existing.fix;
      }
      if (write(checked.binding).status !== "written") return rejected("binding_save_failed");

      if (existing?.schemaVersion === 2 && (existing.cardId !== checked.binding.cardId ||
          checked.binding.schemaVersion !== 2 || bindingSlot(existing) !== slot)) markEmptied(existing.cardId);
      for (const other of list()) {
        if (other.cardId !== checked.binding.cardId || other.taskId === checked.binding.taskId) continue;

        if (checked.binding.schemaVersion !== 2 || other.schemaVersion !== 2 || bindingSlot(other) === slot) clear(other.taskId);
      }
      return { status: "accepted", binding: checked.binding };
    },

    relink(taskId     , pin     ) {
      const existing = read(taskId);
      if (existing?.schemaVersion !== 2) return rejected("card_not_bound");
      const checked      = validateProgramCardBinding({ ...existing, taskVersionId: pin?.taskVersionId,
        requestDigest: pin?.requestDigest }, now());
      if (checked.status !== "accepted") return checked;
      if (existing.last) checked.binding.last = existing.last;

      if (checked.binding.last?.unchecked) {
        checked.binding.last = { ...checked.binding.last, unchecked: Object.fromEntries(Object.entries(checked.binding.last.unchecked)
          .map(([key, entry]     ) => [key, { ...entry, streak: 0 }])) };
      }

      if (existing.fix && existing.requestDigest === checked.binding.requestDigest) checked.binding.fix = existing.fix;
      if (write(checked.binding).status !== "written") return rejected("binding_save_failed");
      return { status: "accepted", binding: checked.binding };
    },

    applyFix(taskId     , change     ) {
      const existing = read(taskId);
      if (existing?.schemaVersion !== 2) return rejected("card_not_bound");
      const checked      = validateProgramCardBinding({ ...existing, revision: change?.revision, sourceHash: change?.sourceHash,
        inputs: change?.inputs }, now());
      if (checked.status !== "accepted") return checked;
      const binding      = checked.binding;
      if (existing.last && isPlainObject(change.values)) {
        if (!taskPresentationData(binding.inputs, change.values)) return rejected("card_values_invalid");
        const blank = binding.inputs.map((entry     ) => entry.key).filter((key        ) => change.values[key] === null);
        const unchecked = validTaskUnchecked(existing.last.unchecked, blank);
        binding.last = { values: { ...change.values }, atMs: existing.last.atMs, source: existing.last.source,
          ...(existing.last.deliveryId ? { deliveryId: existing.last.deliveryId } : {}),
          ...(unchecked ? { unchecked } : {}),
          ...(unchecked && Number.isSafeInteger(existing.last.seenAtMs) ? { seenAtMs: existing.last.seenAtMs } : {}) };
      }
      const fixed = validTaskFixed(change.fixed);
      if (fixed) binding.fixed = fixed;
      if (write(binding).status !== "written") return rejected("binding_save_failed");
      return { status: "accepted", binding };
    },

    undoFix(taskId     , back     ) {
      const existing = read(taskId);
      if (existing?.schemaVersion !== 2 || !existing.fixed) return rejected("fix_undo_gone");
      const checked      = validateProgramCardBinding({ ...existing, revision: back?.revision, sourceHash: back?.sourceHash,
        inputs: back?.inputs }, now());
      if (checked.status !== "accepted") return checked;
      const binding      = checked.binding;
      const last = back?.last;
      if (isPlainObject(last) && isPlainObject(last.values) && Number.isSafeInteger(last.atMs) &&
          taskPresentationData(binding.inputs, last.values)) binding.last = JSON.parse(JSON.stringify(last));
      if (write(binding).status !== "written") return rejected("binding_save_failed");
      return { status: "accepted", binding: read(taskId) || binding };
    },

    restore(binding     ) {
      if (binding?.schemaVersion !== 2 || !isValidLiveuiLibraryItemId(binding.taskId)) return rejected("binding_invalid");
      if (write(binding).status !== "written") return rejected("binding_save_failed");
      return { status: "accepted", binding };
    },

    recordDelivery(taskId     , delivery     ) {
      const binding = read(taskId);
      if (!binding) return null;
      if (binding.schemaVersion === 2 && (delivery.bindingDigest !== binding.bindingDigest ||
          binding.last && delivery.atMs <= binding.last.atMs)) return null;
      let unchecked      = null;
      let fixes      = null;
      if (binding.schemaVersion === 2) {
        fixes = validTaskFixes(delivery.fixes, binding.inputs.map((entry     ) => entry.key));

        const built      = buildTaskUnchecked({ keys: binding.inputs.map((entry     ) => entry.key), values: delivery.values,
          atMs: delivery.atMs, reasons: delivery.reasons, budgetBytes: TASK_UNCHECKED_BUDGET_BYTES - (fixes ? jsonBytes(fixes) : 0),
          prior: binding.last ? { values: binding.last.values, atMs: binding.last.atMs,
            unchecked: binding.last.unchecked, seenAtMs: binding.last.seenAtMs } : null });
        if (built.status === "rejected") return built;
        unchecked = built.unchecked;
      }
      binding.last = {
        values: binding.schemaVersion === 2 ? delivery.values : { ...(binding.last ? binding.last.values : {}), ...delivery.values },
        atMs: delivery.atMs,
        source: delivery.source,
        ...(typeof delivery.deliveryId === "string" ? { deliveryId: delivery.deliveryId } : {}),
        ...(unchecked ? { unchecked } : {}),
        ...(unchecked ? { seenAtMs: delivery.atMs } : {}),
        ...(fixes ? { fixes } : {}),
      };

      if (binding.schemaVersion === 2 && Array.isArray(delivery.unfit)) {
        const fix = nextTaskFix(binding.fix, { inputs: binding.inputs, values: delivery.values, unfit: delivery.unfit,
          raw: delivery.raw, atMs: delivery.atMs, source: delivery.source, deliveryId: delivery.deliveryId });
        if (fix) binding.fix = fix;
        else delete binding.fix;

        const still = binding.fixed ? taskFixStillFails(binding.fixed, binding.fix, delivery.unfit, delivery.atMs) : null;
        if (still) {
          binding.fixed = still.fixed;
          if (still.fix) binding.fix = still.fix;
        }
      }
      if (write(binding).status !== "written") return null;

      if (binding.schemaVersion === 2) {
        fits.write(taskFitRecordFor({ taskId, deliveryId: delivery.deliveryId, source: delivery.source === "schedule" ? "schedule" : "run",
          atMs: delivery.atMs, inputs: binding.inputs, values: delivery.values, fixes, unchecked }));
      }
      return binding;
    },

    fitRecord(taskId     ) {
      return fits.read(taskId);
    },
  };
}

function approvedVersionOf(loaded     ) {
  if (!loaded || loaded.status !== "accepted" || !loaded.task || !loaded.task.versions) return null;
  const approved = loaded.task.versions.approved;
  return approved && typeof approved.versionId === "string" ? approved : null;
}

function createProgramCardFeed(opts      = {}) {
  const store = opts.store;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const send = typeof opts.send === "function" ? opts.send : () => {};
  const logger = opts.logger && typeof opts.logger.info === "function" ? opts.logger : null;
  const loadTask = typeof opts.loadTask === "function" ? opts.loadTask : () => null;
  const controller = () => (typeof opts.taskRunController === "function" ? opts.taskRunController() : null);

  const relaySessionKeyFor = typeof opts.relaySessionKeyFor === "function" ? opts.relaySessionKeyFor : () => "";

  const onFixChanged = typeof opts.onFixChanged === "function" ? opts.onFixChanged : null;

  function approved(taskId     ) {
    try {
      return approvedVersionOf(loadTask(taskId));
    } catch (_) {
      return null;
    }
  }

  function partBudget(binding     ) {
    if (binding?.schemaVersion !== 2 || typeof store.cardSlots !== "function") return TASK_PRESENTATION_DATA_MAX;
    const part = (store.cardSlots(binding.cardId) || []).find((entry     ) => entry.name === bindingSlot(binding));
    return part ? part.maxBytes : TASK_PRESENTATION_DATA_MAX;
  }

  const followsTask = opts.followTask !== false;
  const onTaskFollowed = typeof opts.onTaskFollowed === "function" ? opts.onTaskFollowed : null;

  function storedState(binding     )                                                               {
    const version = approved(binding.taskId);
    if (!version) return "task_missing";
    if (binding.schemaVersion !== 2) return "current";
    const card = typeof opts.loadCard === "function" ? opts.loadCard(binding.cardId) : null;
    if (card?.status !== "accepted" || card.revision !== binding.revision || card.sourceHash !== binding.sourceHash) return "card_changed";
    const expected = taskScheduleBinding(version);
    if (binding.taskVersionId !== expected.taskVersionId || binding.requestDigest !== expected.requestDigest) return "task_changed";
    return "current";
  }

  function bindingState(binding     )                                                               {
    const state = storedState(binding);
    if (state !== "task_changed" || !followsTask) return state;
    const from = binding.taskVersionId;
    const moved      = store.relink(binding.taskId, taskScheduleBinding(approved(binding.taskId)));
    if (moved?.status !== "accepted") {
      logger?.info?.(`[program-card] follow refused task=${binding.taskId} card=${binding.cardId} code=${moved?.code || "-"}`);
      return state;
    }
    for (const key of Object.keys(binding)) delete binding[key];
    Object.assign(binding, moved.binding);
    logger?.info?.(`[program-card] followed task=${binding.taskId} card=${binding.cardId} version=${from}->${binding.taskVersionId}`);

    if (onTaskFollowed) {
      try { onTaskFollowed(binding.taskId); } catch (_) {  }
    }
    return "current";
  }

  function current(binding     ) {
    return bindingState(binding) === "current";
  }

  function draftWaiting(taskId     ) {
    try {
      const loaded = loadTask(taskId);
      return !!(loaded && loaded.status === "accepted" && loaded.task?.versions?.pending);
    } catch (_) {
      return false;
    }
  }

  function toolFailuresOfRun(active     ) {
    if (typeof opts.toolFailuresOf !== "function") return null;
    try {
      return opts.toolFailuresOf(active);
    } catch (_) {
      return null;
    }
  }

  function hostReasons(checked     , failures     ) {
    const unfit = checked.fit && checked.fit.status === "fitted" && Array.isArray(checked.fit.unfit) ? checked.fit.unfit : [];
    return taskToolReasons(checked.values, failures, unfit);
  }

  function deliver(binding     , values     , meta     ) {
    const atMs = Number.isSafeInteger(meta.atMs) ? meta.atMs : now();
    const delivery = {
      taskId: binding.taskId,
      cardId: binding.cardId,
      values,
      atMs,
      source: meta.source,
      ...(binding.schemaVersion === 2 ? { revision: binding.revision, sourceHash: binding.sourceHash, bindingDigest: binding.bindingDigest,
        slot: bindingSlot(binding) } : {}),
      ...(meta.runId ? { runId: meta.runId } : {}),
      ...(meta.resultId ? { resultId: meta.resultId } : {}),
    };
    if (binding.schemaVersion === 2) {

      const fit = meta.fit && meta.fit.status === "fitted" ? meta.fit : null;
      const wasDue = dueKeys(binding.fix);
      const fixBefore = JSON.stringify([binding.fix ?? null, binding.fixed ?? null]);

      const kept = store.recordDelivery(binding.taskId, { values, atMs, source: meta.source,
        deliveryId: meta.resultId || meta.runId, bindingDigest: binding.bindingDigest,
        reasons: fit ? taskFitReasons(fit, meta.reasons) : meta.reasons, fixes: fit ? fit.fixes : null,
        ...(fit ? { unfit: fit.unfit, raw: meta.raw } : {}) });
      if (!kept) return null;
      if (kept.status === "rejected") return kept;

      if (logger && dueKeys(kept.fix) !== wasDue) {
        logger.info(`[program-card] needs a fix card=${binding.cardId} task=${binding.taskId} ${taskFixLog(kept.fix || null) || "cleared"}`);
      }
      const sent      = { ...delivery, ...(kept.last?.unchecked ? { unchecked: kept.last.unchecked } : {}),
        ...(kept.last?.unchecked ? { seenAtMs: kept.last.seenAtMs } : {}),
        ...(kept.last?.fixes ? { fixes: kept.last.fixes } : {}) };
      const fitLine = fit ? taskFitLog(fit) : null;
      if (fitLine && logger) logger.info(`[program-card] fitted card=${binding.cardId} task=${binding.taskId} source=${meta.source} ${fitLine}`);

      send(formatProgramCardData(sent), binding);
      if (onFixChanged && JSON.stringify([kept.fix ?? null, kept.fixed ?? null]) !== fixBefore) {
        try {
          onFixChanged(binding.taskId);
        } catch (_) {

        }
      }
      return sent;
    }
    send(formatProgramCardData(delivery));
    try {
      store.recordDelivery(binding.taskId, {
        values,
        atMs,
        source: meta.source,
        deliveryId: meta.resultId || meta.runId,
      });
    } catch (_) {

    }
    if (logger) {
      logger.info(
        `[program-card] fed card=${binding.cardId} task=${binding.taskId} source=${meta.source} keys=${Object.keys(values).join(",")} atMs=${atMs}`,
      );
    }
    return delivery;
  }

  return {
    store,
    current,
    bindingState,

    fixOffer(binding     , { parts = false }                      = {}) {
      if (binding?.schemaVersion !== 2 || !binding.fix) return null;
      if (typeof store.cardTaskBuilt !== "function" || !store.cardTaskBuilt(binding.cardId)) return null;
      const others = store.forCard(binding.cardId).filter((entry     ) => entry.taskId !== binding.taskId).length;
      if ((others && !parts) || !current(binding)) return null;

      if (draftWaiting(binding.taskId)) return null;
      const offer = taskFixOffer(binding.fix, binding.inputs);

      return offer ? { ...offer, fixable: taskFixPick(binding.inputs, binding.fix, offer.key).status === "accepted",
        ...(others ? { others } : {}) } : null;
    },

    fixDone(binding     , notSynced = false) {
      if (binding?.schemaVersion !== 2 || !binding.fixed || binding.fixed.toRevision !== binding.revision || !current(binding)) return null;
      return taskFixDone(binding.fixed, binding.inputs, now(), notSynced);
    },

    relink(taskId     ) {
      const binding = typeof taskId === "string" ? store.read(taskId) : null;
      if (!binding) return rejected("card_not_bound");
      const state = bindingState(binding);
      if (state === "current") return { status: "accepted", binding };
      if (state === "card_changed") return rejected("presentation_revision_changed");
      if (state !== "task_changed") return rejected("task_not_ready");
      return store.relink(taskId, taskScheduleBinding(approved(taskId)));
    },

    seedLinked(taskId     , values     , atMs     , source     ) {
      const binding = typeof taskId === "string" ? store.read(taskId) : null;
      if (binding?.schemaVersion !== 2 || !values || typeof values !== "object") return null;
      return deliver(binding, values, { source: source === "schedule" || source === "test" ? source : "run",
        atMs: Number.isSafeInteger(atMs) ? atMs : now(), resultId: `link-${taskId}-${Number.isSafeInteger(atMs) ? atMs : now()}` });
    },

    refresh({ clientId, cardId, slot, by }     ) {
      const bound = typeof cardId === "string" ? store.forCard(cardId) : [];
      const binding = typeof slot === "string" ? bound.find((entry     ) => bindingSlot(entry) === slot) : bound[0];
      if (!binding) return Promise.resolve({ cardId, ...(typeof slot === "string" ? { slot } : {}), status: "rejected", code: "card_not_bound" });
      const part = binding.schemaVersion === 2 ? { slot: bindingSlot(binding) } : {};
      if (binding.schemaVersion === 2 && (!opts.canRefresh || !opts.canRefresh(clientId, binding)))
        return Promise.resolve({ cardId, ...part, status: "rejected", code: "presentation_owner_changed" });
      if (!current(binding)) return Promise.resolve({ cardId, taskId: binding.taskId, ...part, status: "rejected",
        code: binding.schemaVersion === 2 ? "presentation_revision_changed" : "task_not_ready" });
      const run = controller();
      if (!run || typeof run.launchTask !== "function") {
        return Promise.resolve({ cardId, taskId: binding.taskId, ...part, status: "rejected", code: "executor_unavailable" });
      }
      return Promise.resolve(run.launchTask({
        taskId: binding.taskId,
        clientId,
        origin: "glasses",

        ...(by === "card" || by === "open" || by === "agent" ? { by } : {}),
        feed: { cardId: binding.cardId, cardName: binding.cardName, keys: binding.inputs.map((entry     ) => entry.key),
          ...(binding.schemaVersion === 2 ? { bindingDigest: binding.bindingDigest, inputs: binding.inputs } : {}) },
      })).then((result     ) => ({
        cardId,
        taskId: binding.taskId,
        ...part,
        status: result && result.status === "accepted" ? "accepted" : "rejected",
        ...(result && typeof result.code === "string" ? { code: result.code } : {}),
      }));
    },

    feedFromRun({ sessionKey, values }     ) {
      const run = controller();
      const active = run && typeof run.activeRun === "function" ? run.activeRun() : null;

      const key = typeof sessionKey === "string" ? relaySessionKeyFor(sessionKey) : "";
      if (!active || !active.feed || !key || active.sessionKey !== key) {
        if (logger) {
          logger.info(
            `[program-card] feed refused run=${active ? active.runId : "none"} state=${active ? active.state : "-"} ` +
            `feed=${!!(active && active.feed)} runSession=${active ? active.sessionKey : "-"} toolSession=${key || "-"}`,
          );
        }
        return rejected("no_feed_run", "feed_card works only inside a Task run started from its card");
      }
      if (active.feed.presentationKind === "surface") {
        const result = typeof opts.deliverSurfaceFromRun === "function" ? opts.deliverSurfaceFromRun({ active, values })
          : rejected("presentation_unavailable");
        if (result?.status === "delivered" && typeof run.observeFeed === "function") run.observeFeed({ sessionKey: key });
        return result;
      }
      const binding = store.read(active.taskId);
      if (!binding || binding.cardId !== active.feed.cardId) return rejected("card_not_bound");

      const state = bindingState(binding);
      if (binding.schemaVersion === 2 && active.feed.bindingDigest !== binding.bindingDigest)
        return rejected("presentation_revision_changed");
      if (state !== "current") return rejected("task_not_ready");
      const checked      = checkProgramCardValues(binding, values, partBudget(binding));
      if (checked.status !== "accepted") return checked;

      const delivery      = deliver(binding, checked.values, { source: "run", runId: active.runId, fit: checked.fit,
        reasons: hostReasons(checked, toolFailuresOfRun(active)), raw: values });
      if (!delivery) return { status: "skipped", reason: "stale_result" };
      if (delivery.status === "rejected") return delivery;
      if (typeof run.observeFeed === "function") run.observeFeed({ sessionKey: key });
      return {
        status: "delivered",
        cardId: binding.cardId,
        keys: Object.keys(checked.values),
        dropped: checked.dropped,
        atMs: delivery.atMs,
        ...uncheckedOutcome(delivery),

        ...fitOutcome(checked.fit),
      };
    },

    deliverTaskResult({ taskId, result }     ) {
      const outcome = deliverScheduled(taskId, result);

      if (typeof opts.onTaskResult === "function") {
        try { opts.onTaskResult({ taskId, result, outcome }); } catch (_) {  }
      }
      return outcome;
    },
  };

  function deliverScheduled(taskId     , result     )      {
    if (typeof taskId !== "string" || !taskId) return { status: "skipped", reason: "no_task" };
    const binding = store.read(taskId);
    if (!binding) return { status: "skipped", reason: "card_not_bound" };
    if (!current(binding)) return rejected("task_not_ready");
    if (!isPlainObject(result) || result.status !== "ok") return { status: "skipped", reason: "not_ok" };
    const resultId = typeof result.id === "string" ? result.id : undefined;
    if (resultId && binding.last && binding.last.deliveryId === resultId) {
      return { status: "skipped", reason: "already_delivered" };
    }
    let checked      = checkProgramCardValues(binding, result.card, partBudget(binding));
    if (checked.status !== "accepted" && binding.schemaVersion === 2) {

      logger?.info?.(`[program-card] scheduled result has no usable card task=${taskId} result=${resultId || "-"} code=${checked.code}`);
      checked = { status: "accepted", values: Object.fromEntries(binding.inputs.map((entry     ) => [entry.key, null])), dropped: [] };
    }
    if (checked.status !== "accepted") return checked;
    const delivery      = deliver(binding, checked.values, {
      source: "schedule",
      atMs: Number.isSafeInteger(result.createdAtMs) ? result.createdAtMs : now(),
      resultId,
      fit: checked.fit,

      reasons: hostReasons(checked, result.toolFailures),
      raw: result.card,
    });
    if (!delivery) return { status: "skipped", reason: "stale_result" };
    if (delivery.status === "rejected") return delivery;
    return { status: "delivered", cardId: binding.cardId, keys: Object.keys(checked.values), dropped: checked.dropped,
      atMs: delivery.atMs, ...uncheckedOutcome(delivery) };
  }
}

function dueKeys(fix     )         {
  if (!isPlainObject(fix) || !isPlainObject(fix.keys)) return "";
  return Object.keys(fix.keys).filter((key) => taskFixDue(fix.keys[key])).sort().join(",");
}

function fitOutcome(fit     ) {
  if (!fit || fit.status !== "fitted") return {};
  return {
    values: fit.values,
    ...(Object.keys(fit.fixes).length ? { fixes: fit.fixes } : {}),
    ...(fit.unfit.length ? { unfit: fit.unfit } : {}),
    ...(fit.missing.length ? { missing: fit.missing } : {}),
  };
}

function uncheckedOutcome(delivery     ) {
  const keys = isPlainObject(delivery.unchecked) ? Object.keys(delivery.unchecked) : [];
  if (!keys.length) return {};
  const all = isPlainObject(delivery.values) && Object.values(delivery.values).every((value) => value === null);
  return { unchecked: keys, ...(all ? { allUnchecked: true } : {}) };
}

module.exports = { PROGRAM_CARD_OWNER_SAVED_SHAPE, PROGRAM_CARD_STARTER_SAVED_SHAPE, PROGRAM_CARD_BINDING_SAVED_SHAPE, PROGRAM_CARD_DATA_FRAME, PROGRAM_CARD_BINDINGS_FRAME, PROGRAM_CARD_REFRESH_RESULT_FRAME, PROGRAM_CARD_FEED_OPERATION, PROGRAM_CARD_FOLLOW_OWN_CHANGES_ENV, programCardFollowsOwnChanges, PROGRAM_CARD_VALUE_MAX_CHARS, feedCardFromScheduledResult, validateProgramCardBinding, PROGRAM_CARD_PROPOSABLE_CARDS, programCardKeyFor, programCardLinkFromAgent, programCardProposalBoundTo, checkProgramCardValues, formatProgramCardData, projectProgramCardBindingForPhone, projectProgramCardProposalForPhone, formatProgramCardBindings, formatProgramCardRefreshResult, programCardLook, createProgramCardFeedStore, createProgramCardFeed };
