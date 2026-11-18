const { cardStarterName, cardStarterSource } = require("../tools/card-starters.cjs");
const { liveuiLibraryDigest } = require("../tools/glasses-ui-library.cjs");
const { validateLiveUiInputs } = require("../tools/liveui-compiler/template-inputs.cjs");
const { starterCheckDigest } = require("../tools/task-starter-check.cjs");

const TASK_CARD_TEST_SOURCE = "test";

function sameStarterInputs(a         , b         )          {
  const left      = validateLiveUiInputs(a);
  const right      = validateLiveUiInputs(b);
  return left.ok && right.ok && left.inputs.length > 0 && liveuiLibraryDigest(left.inputs) === liveuiLibraryDigest(right.inputs);
}

function taskCardLibraryName(title         , taskName         )         {
  const base = (typeof title === "string" && title.trim() ? title : typeof taskName === "string" ? taskName : "")
    .trim().replace(/\s+/g, " ").slice(0, 53).trimEnd();
  const task = typeof taskName === "string" ? taskName.trim().toLocaleLowerCase() : "";
  return base.toLocaleLowerCase() === task ? `${base} · Card` : base;
}

function starterCardLibraryName(base        , taskName         , taken                           )         {
  const first = taskCardLibraryName(base, taskName);
  const task = typeof taskName === "string" ? taskName.trim().toLocaleLowerCase() : "";
  const free = (name        ) => name.toLocaleLowerCase() !== task && !taken(name);
  if (free(first)) return first;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${first} ${n}`;
    if (free(candidate)) return candidate;
  }
  return `${first} ${Date.now() % 100000}`;
}

const STARTER_CREATE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function createTaskCardCreate(deps     ) {
  const active = new Set        ();
  const rejected = (code        ) => ({ status: "rejected", code });

  async function save(clientId        , input     , perform                                   ) {
    const handle = input?.card?.handle;
    const end = deps.buildEnd(handle);

    if (end?.outcome === "no_fit") return rejected("card_no_fit");
    if (!end || end.outcome !== "draft" || typeof end.draftId !== "string") return rejected("card_build_missing");
    const taskId = `setup-${end.draftId}`;
    if (active.has(taskId)) return rejected("card_save_busy");
    active.add(taskId);
    try {
      const owner = deps.owner(end.sessionKey, clientId);
      if (!owner) return rejected("card_owner_changed");
      const resumed = deps.taskSaved(taskId) === true;
      const test = deps.testCard(input.testId);
      if (!test && !resumed) return rejected("card_test_missing");
      const draft = await deps.draft(end.sessionKey, end.draftId);
      if (!draft?.ok) return rejected(typeof draft?.error === "string" ? draft.error : "card_draft_missing");

      if (end.addTo !== undefined) return saveAdded(clientId, input, perform, { end, taskId, owner, test, draft });

      if (draft.base) return rejected("card_not_new");
      const wasSaved = draft.status === "saved";
      const card = deps.promote(end.sessionKey, clientId, { draft, card: draft.card, state: draft.state,
        name: taskCardLibraryName(draft.title, input.name), by: "owner" });
      if (card?.status !== "saved") return rejected(typeof card?.code === "string" ? card.code : "card_save_failed");
      let result     ;
      let kept      = null;
      try {
        result = await perform({ ...input, card: undefined }, {
          agentId: owner.agentId, taskId, allowCreate: true,
          beforeApprove: (version     , plan     ) => {
            const bound = deps.bind({ taskId, version, card, test, owner: owner.owner, plan });
            kept = bound?.status === "accepted" && bound.kept ? bound.kept : null;
            return bound;
          },
        });
      } catch (_) {
        result = rejected("task_save_failed");
      }
      if (result?.status === "saved") {
        deps.forgetBuild(handle);
        return { ...result, card: { appId: card.appId, name: card.name, revision: card.revision, draftId: end.draftId },
          ...(kept ? { kept } : {}) };
      }
      if (!resumed) rollback(taskId, end, card.appId, wasSaved);
      return result && typeof result === "object" ? result : rejected("task_save_failed");
    } finally {
      active.delete(taskId);
    }
  }

  async function saveStarter(clientId        , input     , perform                                   ) {
    const ask = input?.starterCard;
    const starterId = typeof ask?.id === "string" ? ask.id : null;
    const key = typeof ask?.key === "string" ? ask.key.toLowerCase() : "";
    if (!starterId || !STARTER_CREATE_KEY_RE.test(key)) return rejected("starter_card_invalid");
    const taskId = `setup-${key}`;
    if (active.has(taskId)) return rejected("card_save_busy");
    active.add(taskId);
    try {
      const owner = deps.phoneOwner(clientId);
      if (!owner) return rejected("card_owner_changed");
      const forTask = { ...input, starterCard: undefined, card: undefined };

      if (deps.taskSaved(taskId) === true) {
        const binding = deps.bindingOf(taskId);
        if (!binding || typeof binding.cardId !== "string") return rejected("starter_fit_missing");
        const card = { appId: binding.cardId, name: binding.cardName, revision: binding.revision };
        const result = await perform(forTask, { agentId: owner.agentId, taskId, allowCreate: true,
          beforeApprove: (version     , plan     ) => deps.bind({ taskId, version, card, test: null, owner: owner.owner, plan }) });
        return result?.status === "saved" ? { ...result, card: { ...card, starter: starterId } } : result;
      }
      const test = deps.testCard(input.testId);
      if (!test) return rejected("card_test_missing");
      const ran = deps.starterOf(input.testId);
      if (!ran?.starter || ran.starter.starterId !== starterId) return rejected("starter_card_changed");
      const held = deps.starterFit(input.testId, clientId);
      if (!held) return rejected("starter_check_missing");
      if (held.status !== "fits") return rejected("card_no_fit");
      const starter = ran.starter;
      const source = cardStarterSource(starter, ran.locale);
      if (held.starterId !== starter.starterId || held.version !== starter.version || held.digest !== starterCheckDigest(source))
        return rejected("starter_check_stale");

      if (!sameStarterInputs(test.inputs, starter.inputs)) return rejected("starter_inputs_changed");
      const name = starterCardLibraryName(cardStarterName(starter, ran.locale), input.name, (candidate) => deps.nameTaken(candidate) === true);
      const mark = { id: starter.starterId, version: starter.version };
      const card = deps.saveStarterCard({ name, source, inputs: starter.inputs, starter: mark, owner: owner.owner });
      if (card?.status !== "saved") return rejected(typeof card?.code === "string" ? card.code : "card_save_failed");
      const undo = () => {
        for (const step of [() => deps.unbind(taskId), () => deps.dropTask(taskId), () => deps.deleteCard(card.appId)]) {
          try { step(); } catch (_) {  }
        }
      };
      let markedOk = false;
      try { markedOk = deps.markStarter(card.appId, mark) === true; } catch (_) { markedOk = false; }
      if (!markedOk) {
        undo();
        return rejected("card_save_failed");
      }
      let result     ;
      let kept      = null;
      try {

        result = await perform(forTask, {
          agentId: owner.agentId, taskId, allowCreate: true,
          beforeApprove: (version     , plan     ) => {
            const bound = deps.bind({ taskId, version, card, test, owner: owner.owner, plan });
            kept = bound?.status === "accepted" && bound.kept ? bound.kept : null;
            return bound;
          },
        });
      } catch (_) {
        result = rejected("task_save_failed");
      }
      if (result?.status === "saved") {
        return { ...result, card: { appId: card.appId, name: card.name, revision: card.revision, starter: starterId },
          ...(kept ? { kept } : {}) };
      }

      undo();
      return result && typeof result === "object" ? result : rejected("task_save_failed");
    } finally {
      active.delete(taskId);
    }
  }

  async function saveAdded(clientId        , input     , perform                                   ,
      { end, taskId, owner, test, draft }     ) {
    const cardId = end.addTo;
    if (draft.base?.appId !== cardId) return rejected("card_not_revision");
    if (!test) return rejected("card_test_missing");
    const plan = deps.addPlan({ cardId, taskId, test, owner: owner.owner, part: end.part || null, name: input?.name });
    if (plan?.status !== "accepted") return plan && typeof plan === "object" && plan.status ? plan : rejected("card_unavailable");
    const card = deps.promoteRevision(end.sessionKey, clientId, { draft, card: draft.card, state: draft.state,
      name: plan.name || draft.title, by: "owner", mode: "revision" }, plan.table);
    if (card?.status !== "saved") return rejected(typeof card?.code === "string" ? card.code : "card_save_failed");
    let pinned      = { repinned: [], failed: [] };
    try {
      pinned = await deps.repin(cardId, card, plan.table, taskId);
    } catch (_) {  }
    const inputs = plan.table.find((part     ) => part.name === plan.slot)?.inputs;
    let result     ;
    try {
      result = await perform({ ...input, card: undefined }, {
        agentId: owner.agentId, taskId, allowCreate: true,
        beforeApprove: (version     ) => deps.bindPart({ taskId, version, card, test, owner: owner.owner, slot: plan.slot, inputs }),
      });
    } catch (_) {
      result = rejected("task_save_failed");
    }
    if (result?.status === "saved") {
      deps.forgetBuild(input.card.handle);
      return { ...result, card: { appId: card.appId, name: card.name, revision: card.revision, draftId: end.draftId, slot: plan.slot },
        repinned: pinned.repinned, ...(pinned.failed.length ? { unpinned: pinned.failed } : {}) };
    }
    for (const step of [() => deps.unbind(taskId), () => deps.dropTask(taskId)]) {
      try { step(); } catch (_) {  }
    }
    return result && typeof result === "object" ? result : rejected("task_save_failed");
  }

  function rollback(taskId        , end     , appId        , wasSaved         ) {
    for (const step of [() => deps.unbind(taskId), () => deps.dropTask(taskId),
      () => wasSaved ? null : deps.unsave(end.sessionKey, end.draftId, appId)]) {
      try { step(); } catch (_) {  }
    }
  }

  async function attach(clientId        , input     ) {
    const taskId = input?.taskId;
    const handle = input?.handle;
    const end = deps.buildEnd(handle);
    if (end?.outcome === "no_fit") return rejected("card_no_fit");
    if (!end || end.outcome !== "draft" || typeof end.draftId !== "string") return rejected("card_build_missing");
    if (active.has(taskId)) return rejected("card_save_busy");
    active.add(taskId);
    try {
      const task = deps.savedTask(taskId);
      if (!task) return rejected("task_not_found");
      if (deps.hasCard(taskId) === true) return rejected("task_has_card");
      const owner = deps.owner(end.sessionKey, clientId);
      if (!owner) return rejected("card_owner_changed");
      const test = deps.testCard(input.testId);
      if (!test) return rejected("card_test_missing");
      const draft = await deps.draft(end.sessionKey, end.draftId);
      if (!draft?.ok) return rejected(typeof draft?.error === "string" ? draft.error : "card_draft_missing");
      if (draft.base) return rejected("card_not_new");
      const wasSaved = draft.status === "saved";
      const card = deps.promote(end.sessionKey, clientId, { draft, card: draft.card, state: draft.state,
        name: taskCardLibraryName(draft.title, task.name), by: "owner" });
      if (card?.status !== "saved") return rejected(typeof card?.code === "string" ? card.code : "card_save_failed");
      const undo = () => {
        for (const step of [() => deps.unbind(taskId), () => wasSaved ? null : deps.unsave(end.sessionKey, end.draftId, card.appId)]) {
          try { step(); } catch (_) {  }
        }
      };
      let bound     ;
      try {
        bound = deps.bind({ taskId, version: task.version, card, test, owner: owner.owner });
      } catch (_) {
        bound = rejected("binding_save_failed");
      }
      if (bound?.status !== "accepted") {
        undo();
        return bound && typeof bound === "object" && bound.status ? bound : rejected("binding_save_failed");
      }
      let used     ;
      try {
        used = await deps.useCard(taskId);
      } catch (_) {
        used = rejected("presentation_schedule_unsynced");
      }
      if (used?.status !== "accepted") {
        undo();
        return used && typeof used === "object" && used.status ? used : rejected("presentation_schedule_unsynced");
      }
      deps.forgetBuild(handle);
      try { deps.dropTest(input.testId); } catch (_) {  }
      return { status: "saved", taskId, card: { appId: card.appId, name: card.name, revision: card.revision, draftId: end.draftId },
        ...(used.kept ? { kept: used.kept } : {}) };
    } finally {
      active.delete(taskId);
    }
  }

  async function attachStarter(clientId        , input     ) {
    const taskId = input?.taskId;
    const starterId = typeof input?.starterCard === "string" ? input.starterCard : null;
    if (!starterId || typeof taskId !== "string") return rejected("starter_card_invalid");
    if (active.has(taskId)) return rejected("card_save_busy");
    active.add(taskId);
    try {
      const task = deps.savedTask(taskId);
      if (!task) return rejected("task_not_found");
      if (deps.hasCard(taskId) === true) {
        const binding = deps.bindingOf(taskId);
        const from = binding && typeof binding.cardId === "string" ? deps.cardStarter(binding.cardId) : null;
        if (from?.starterId !== starterId) return rejected("task_has_card");
        return { status: "saved", taskId, card: { appId: binding.cardId, name: binding.cardName, revision: binding.revision, starter: starterId } };
      }
      if (deps.savedTaskStarter(taskId)?.id !== starterId) return rejected("starter_card_changed");
      const owner = deps.phoneOwner(clientId);
      if (!owner) return rejected("card_owner_changed");
      const test = deps.taskTestCard(input.testId, taskId);
      if (!test) return rejected("card_test_missing");
      const ran = deps.starterOf(input.testId);
      if (!ran?.starter || ran.starter.starterId !== starterId) return rejected("starter_card_changed");
      const held = deps.starterFit(input.testId, clientId);
      if (!held) return rejected("starter_check_missing");
      if (held.status !== "fits") return rejected("card_no_fit");
      const starter = ran.starter;
      const source = cardStarterSource(starter, ran.locale);
      if (held.starterId !== starter.starterId || held.version !== starter.version || held.digest !== starterCheckDigest(source))
        return rejected("starter_check_stale");
      if (!sameStarterInputs(test.inputs, starter.inputs)) return rejected("starter_inputs_changed");
      const name = starterCardLibraryName(cardStarterName(starter, ran.locale), task.name, (candidate) => deps.nameTaken(candidate) === true);
      const mark = { id: starter.starterId, version: starter.version };
      const card = deps.saveStarterCard({ name, source, inputs: starter.inputs, starter: mark, owner: owner.owner });
      if (card?.status !== "saved") return rejected(typeof card?.code === "string" ? card.code : "card_save_failed");
      const undo = () => {
        for (const step of [() => deps.unbind(taskId), () => deps.deleteCard(card.appId)]) {
          try { step(); } catch (_) {  }
        }
      };
      let markedOk = false;
      try { markedOk = deps.markStarter(card.appId, mark) === true; } catch (_) { markedOk = false; }
      if (!markedOk) {
        undo();
        return rejected("card_save_failed");
      }
      let bound     ;
      try {
        bound = deps.bind({ taskId, version: task.version, card, test, owner: owner.owner });
      } catch (_) {
        bound = rejected("binding_save_failed");
      }
      if (bound?.status !== "accepted") {
        undo();
        return bound && typeof bound === "object" && bound.status ? bound : rejected("binding_save_failed");
      }
      let used     ;
      try {
        used = await deps.useCard(taskId);
      } catch (_) {
        used = rejected("presentation_schedule_unsynced");
      }
      if (used?.status !== "accepted") {
        undo();
        return used && typeof used === "object" && used.status ? used : rejected("presentation_schedule_unsynced");
      }
      try { deps.dropTest(input.testId); } catch (_) {  }
      return { status: "saved", taskId, card: { appId: card.appId, name: card.name, revision: card.revision, starter: starterId },
        ...(used.kept ? { kept: used.kept } : {}) };
    } finally {
      active.delete(taskId);
    }
  }

  async function add(clientId        , input     ) {
    const taskId = input?.taskId;
    const cardId = input?.addTo;
    const handle = input?.handle;
    const end = deps.buildEnd(handle);
    if (end?.outcome === "no_fit") return rejected("card_no_fit");
    if (!end || end.outcome !== "draft" || typeof end.draftId !== "string") return rejected("card_build_missing");

    if (end.addTo !== undefined && end.addTo !== cardId) return rejected("card_not_revision");
    if (active.has(taskId)) return rejected("card_save_busy");
    active.add(taskId);
    try {
      const task = deps.savedTask(taskId);
      if (!task) return rejected("task_not_found");
      const owner = deps.owner(end.sessionKey, clientId);
      if (!owner) return rejected("card_owner_changed");
      const test = deps.testCard(input.testId);
      if (!test) return rejected("card_test_missing");
      const draft = await deps.draft(end.sessionKey, end.draftId);
      if (!draft?.ok) return rejected(typeof draft?.error === "string" ? draft.error : "card_draft_missing");

      if (draft.base?.appId !== cardId) return rejected("card_not_revision");
      const plan = deps.addPlan({ cardId, taskId, test, owner: owner.owner, part: end.part || null });
      if (plan?.status !== "accepted") return plan && typeof plan === "object" && plan.status ? plan : rejected("card_unavailable");
      const card = deps.promoteRevision(end.sessionKey, clientId, { draft, card: draft.card, state: draft.state,
        name: plan.name || draft.title, by: "owner", mode: "revision" }, plan.table);
      if (card?.status !== "saved") return rejected(typeof card?.code === "string" ? card.code : "card_save_failed");
      let pinned      = { repinned: [], failed: [] };
      try {
        pinned = await deps.repin(cardId, card, plan.table, taskId);
      } catch (_) {  }
      let bound     ;
      try {
        bound = deps.bindPart({ taskId, version: task.version, card, test, owner: owner.owner, slot: plan.slot,
          inputs: plan.table.find((part     ) => part.name === plan.slot)?.inputs });
      } catch (_) {
        bound = rejected("binding_save_failed");
      }
      if (bound?.status !== "accepted") return bound && typeof bound === "object" && bound.status ? bound : rejected("binding_save_failed");
      let used     ;
      try {
        used = await deps.useCard(taskId);
      } catch (_) {
        used = rejected("presentation_schedule_unsynced");
      }
      if (used?.status !== "accepted") return used && typeof used === "object" && used.status ? used : rejected("presentation_schedule_unsynced");
      deps.forgetBuild(handle);
      try { deps.dropTest(input.testId); } catch (_) {  }
      return { status: "saved", taskId, card: { appId: card.appId, name: card.name, revision: card.revision, draftId: end.draftId,
        slot: plan.slot }, repinned: pinned.repinned, ...(pinned.failed.length ? { unpinned: pinned.failed } : {}) };
    } finally {
      active.delete(taskId);
    }
  }

  async function drop(handle        )                   {
    const end = deps.buildEnd(handle);
    if (!end) return false;
    deps.forgetBuild(handle);

    if ((end.outcome !== "draft" && end.outcome !== "no_fit") || typeof end.draftId !== "string") return true;
    if (deps.taskSaved(`setup-${end.draftId}`) === true) return true;
    try {
      return (await deps.discard(end.sessionKey, end.draftId)) === true;
    } catch (_) {
      return false;
    }
  }

  return { save, saveStarter, attach, attachStarter, add, drop };
}

module.exports = { TASK_CARD_TEST_SOURCE, sameStarterInputs, taskCardLibraryName, starterCardLibraryName, createTaskCardCreate };
