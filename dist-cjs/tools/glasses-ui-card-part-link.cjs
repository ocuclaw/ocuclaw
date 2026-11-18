const { fitTaskValues } = require("./glasses-ui-task-fit.cjs");
const { TASK_SLOT_FIRST, bindingSlot, cardTaskSlots, validTaskSlotName } = require("./glasses-ui-task-slots.cjs");
const { taskScheduleBinding } = require("./glasses-ui-task-schedule.cjs");

const CARD_PART_LINK_CODES = Object.freeze({
  invalid: "binding_invalid",
  taskMissing: "task_not_found",
  notBrief: "not_brief",
  cardMissing: "card_unavailable",
  owner: "presentation_owner_changed",
  otherAgent: "task_agent_other",
  undeclared: "task_slot_undeclared",
  taken: "card_part_taken",
  noResult: "task_result_missing",
  unfit: "task_values_unfit",
});

const C = CARD_PART_LINK_CODES;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCOPE_RE = /^sha256:[a-f0-9]{64}$/;

const rejected = (code        , extra      = {}) => ({ status: "rejected", code, ...extra });

function taskFitsPart(part     , sources       )      {
  const usable = (Array.isArray(sources) ? sources : []).filter((entry) =>
    entry && entry.values && typeof entry.values === "object" && !Array.isArray(entry.values) && Number.isSafeInteger(entry.atMs));
  if (!part || !Array.isArray(part.inputs) || !usable.length) return { fit: "unknown", code: C.noResult };
  const newest = usable.sort((a, b) => b.atMs - a.atMs)[0];
  const keys = part.inputs.map((input     ) => input.key);
  const fitted      = fitTaskValues(part.inputs, newest.values, { budgetBytes: part.maxBytes });
  if (fitted.status !== "fitted") return { fit: "unfit", code: C.unfit, keys, atMs: newest.atMs };
  const known = (list     ) => (Array.isArray(list) ? list : []).filter((key        ) => keys.includes(key));
  const missing = [...new Set([...fitted.missing, ...known(newest.missing)])];
  const unfit = [...new Set([...fitted.unfit, ...known(newest.unfit)])];
  if (missing.length || unfit.length) {
    return { fit: "unfit", code: C.unfit, ...(missing.length ? { missing } : {}), ...(unfit.length ? { unfit } : {}), atMs: newest.atMs };
  }
  return { fit: "fits", values: fitted.values, atMs: newest.atMs, source: newest.source === "test" ? "test" : newest.source || "run" };
}

function createCardPartLink(opts      = {}) {
  const store = opts.store;
  const feed = opts.feed;
  const card = typeof opts.card === "function" ? opts.card : () => null;
  const task = typeof opts.task === "function" ? opts.task : () => null;
  const taskScope = typeof opts.taskScope === "function" ? opts.taskScope : () => null;
  const clientOwns = typeof opts.clientOwns === "function" ? opts.clientOwns : () => false;
  const taskName = typeof opts.taskName === "function" ? opts.taskName : (taskId        ) => taskId;
  const testCard = typeof opts.testCard === "function" ? opts.testCard : () => null;

  const cap = typeof opts.cap === "function" ? opts.cap : () => 1;
  const clientParts = typeof opts.clientParts === "function" ? opts.clientParts : () => false;

  function stateOf(binding     ) {
    try { return feed.bindingState(binding); } catch (_) { return "task_missing"; }
  }

  function testSource(tested     ) {
    return tested && tested.values ? { values: tested.values, atMs: tested.atMs, source: "test",
      missing: tested.missing, unfit: tested.unfit } : null;
  }

  function sourcesFor(taskId        , testId         , tested      = null) {
    const out        = [];
    const test = testSource(tested || (typeof testId === "string" && testId ? testCard(testId, taskId) : null));
    if (test) out.push(test);
    const bound = store.read(taskId);
    if (bound?.schemaVersion === 2 && bound.last) out.push({ values: bound.last.values, atMs: bound.last.atMs, source: bound.last.source });
    return out;
  }

  function cardParts(cardId        ) {
    const scope = store.ownerScope(cardId);
    if (!scope || scope === "unavailable" || !SCOPE_RE.test(scope)) return null;
    const source = card(cardId);
    if (!source || source.status !== "accepted") return null;
    const bound = store.forCard(cardId).filter((binding     ) => binding.schemaVersion === 2);
    const first = bound.find((binding     ) => bindingSlot(binding) === TASK_SLOT_FIRST);
    const declared = cardTaskSlots(source, first?.inputs || null) || [];
    return { scope, source, bound, declared };
  }

  function parts({ clientId, taskId, testId }     ) {
    if (typeof taskId !== "string" || !ID_RE.test(taskId)) return rejected(C.invalid);
    const saved = task(taskId);
    if (!saved) return rejected(C.taskMissing);
    if (saved.kind !== "brief") return rejected(C.notBrief);
    const scope = taskScope(taskId, saved.version);
    const current = store.read(taskId);
    const from = current?.schemaVersion === 2 ? current : null;
    const listed = listParts(clientId, scope, taskId, sourcesFor(taskId, testId));
    const fromEntry = listed.from || (from ? { cardId: from.cardId, cardName: from.cardName, slot: bindingSlot(from) } : null);
    return { status: "accepted", taskId, ...(fromEntry ? { from: fromEntry } : {}), parts: listed.parts, addable: listed.addable };
  }

  function partsForNew({ clientId, scope, tested }     ) {
    if (typeof scope !== "string" || !SCOPE_RE.test(scope)) return rejected(C.invalid);
    const source = testSource(tested);
    const listed = listParts(clientId, scope, null, source ? [source] : []);
    return { status: "accepted", parts: listed.parts, addable: listed.addable };
  }

  function listParts(clientId        , scope               , taskId               , sources       ) {
    const list        = [];

    const addable        = [];
    const most = clientParts(clientId) ? cap() : 1;
    let fromEntry      = null;
    for (const cardId of store.ownedCards()) {
      const found = cardParts(cardId);
      if (!found || !clientOwns(clientId, found.scope) || found.scope !== scope) continue;
      const cardName = typeof found.source.name === "string" && found.source.name ? found.source.name : cardId;
      if (found.declared.length && found.declared.length < most && !found.bound.some((binding     ) => binding.taskId === taskId))
        addable.push({ cardId, cardName, with: found.bound.map((binding     ) => taskName(binding.taskId)) });
      for (const part of found.declared) {
        const held = found.bound.find((binding     ) => bindingSlot(binding) === part.name);
        if (taskId && held?.taskId === taskId) {
          fromEntry = { cardId, cardName, slot: part.name, label: part.label };
          continue;
        }
        const others = found.bound.filter((binding     ) => binding.taskId !== taskId && binding !== held)
          .map((binding     ) => taskName(binding.taskId));
        const state = !held ? "empty" : stateOf(held) === "current" ? "filled" : "stopped";
        const fit = taskFitsPart(part, sources);
        list.push({ cardId, cardName, slot: part.name, label: part.label, state,
          ...(held ? { heldBy: { taskId: held.taskId, name: taskName(held.taskId) } } : {}),
          with: others, fit: fit.fit, ...(fit.code ? { code: fit.code } : {}),
          ...(fit.missing ? { missing: fit.missing } : {}), ...(fit.unfit ? { unfit: fit.unfit } : {}) });
      }
    }
    return { parts: list, addable, from: fromEntry };
  }

  function link({ clientId, taskId, cardId, slot, replace, testId, tested }     ) {
    if (typeof taskId !== "string" || !ID_RE.test(taskId) || typeof cardId !== "string" || !ID_RE.test(cardId) ||
        !validTaskSlotName(slot)) return rejected(C.invalid);
    const saved = task(taskId);
    if (!saved) return rejected(C.taskMissing);
    if (saved.kind !== "brief") return rejected(C.notBrief);
    const found = cardParts(cardId);
    if (!found) return rejected(C.cardMissing);
    if (!clientOwns(clientId, found.scope)) return rejected(C.owner);
    if (taskScope(taskId, saved.version) !== found.scope) return rejected(C.otherAgent);
    const part = found.declared.find((entry     ) => entry.name === slot);
    if (!part) return rejected(C.undeclared);
    const held = found.bound.find((binding     ) => bindingSlot(binding) === slot && binding.taskId !== taskId);
    if (held && stateOf(held) === "current" && replace !== true) return rejected(C.taken, { heldBy: held.taskId });
    const fit = taskFitsPart(part, sourcesFor(taskId, testId, tested));
    if (fit.fit !== "fits") return rejected(fit.code || C.unfit, {
      ...(fit.missing ? { missing: fit.missing } : {}), ...(fit.unfit ? { unfit: fit.unfit } : {}) });
    const previous = store.read(taskId);
    const bound      = store.bind({ schemaVersion: 2, taskId, cardId, cardName: found.source.name, slot,
      revision: found.source.revision, sourceHash: found.source.sourceHash, ownerScope: found.scope,
      ...taskScheduleBinding(saved.version), inputs: part.inputs });
    if (bound?.status !== "accepted") return bound || rejected("binding_save_failed");
    if (typeof feed.seedLinked === "function") feed.seedLinked(taskId, fit.values, fit.atMs, fit.source);
    const moved = previous && (previous.cardId !== cardId || bindingSlot(previous) !== slot) ? previous.cardId : null;
    return { status: "linked", taskId, cardId, slot, binding: bound.binding,
      ...(held ? { replaced: held.taskId } : {}), ...(moved ? { movedFrom: moved } : {}) };
  }

  return { parts, partsForNew, link };
}

module.exports = { CARD_PART_LINK_CODES, taskFitsPart, createCardPartLink };
