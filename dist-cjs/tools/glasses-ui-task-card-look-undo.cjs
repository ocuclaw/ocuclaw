const { taskKeptLookFor } = require("./glasses-ui-task-kept-look.cjs");

const rejected = (code        ) => ({ status: "rejected", code });
const onAgentCard = (plan     ) => !!plan && !!plan.look && plan.look.kind === "agent";

function createTaskCardLookUndo(deps     ) {
  const log = deps.logger && typeof deps.logger.info === "function" ? deps.logger : null;
  const storeOf = () => (typeof deps.store === "function" ? deps.store() : deps.store) || null;

  function keep(taskId        , cardId        , plan     ) {
    const store = storeOf();
    if (!store) return null;
    const kept = taskKeptLookFor(plan);
    if (!kept) {

      try { store.forgetLook(taskId); } catch (_) {  }
      return null;
    }
    if (store.keepLook(taskId, cardId, kept) !== true) {
      log?.warn?.(`[program-card] kept layout not written task=${taskId}`);
      return null;
    }
    return { templateId: kept.templateId };
  }

  async function putBack(taskId        , kept     ) {
    try {
      const set      = await deps.setLook(taskId, kept.look);
      return !!set && (set.status === "saved" || set.status === "unchanged") ? null : (set?.code || "presentation_look_failed");
    } catch (_) {
      return "presentation_look_failed";
    }
  }

  async function undo(clientId        , { taskId, cardId }     ) {
    const store = storeOf();
    if (!store) return rejected("presentation_unavailable");
    const binding = store.read(taskId);
    if (!binding || binding.cardId !== cardId) return rejected("card_undo_gone");
    if (deps.owns(clientId, binding) !== true) return rejected("presentation_owner_changed");
    const kept = store.keptLook(taskId);
    if (!kept || kept.cardId !== cardId) return rejected("card_undo_gone");
    const plan = deps.readPlan(taskId);
    if (!onAgentCard(plan)) return rejected("card_undo_gone");
    const failed = await putBack(taskId, kept);
    if (failed) return rejected(failed);
    const cleared      = store.clear(taskId);

    if (cleared?.status !== "accepted") log?.warn?.(`[program-card] undo left the card link task=${taskId} card=${cardId}`);
    store.forgetLook(taskId);

    if (plan.when) {
      try { await deps.reconcile(taskId); } catch (err     ) {
        log?.warn?.(`[program-card] undo sync failed task=${taskId}: ${err?.message || err}`);
      }
    }
    deps.pushBindings();
    log?.info(`[program-card] undo task=${taskId} card=${cardId} layout=${kept.templateId}`);
    return { status: "undone", taskId, kept: { templateId: kept.templateId } };
  }

  async function restore(taskId        , cardId        ) {
    const store = storeOf();
    const kept = store ? store.keptLook(taskId) : null;
    if (!kept || kept.cardId !== cardId) return false;
    const failed = onAgentCard(deps.readPlan(taskId)) ? await putBack(taskId, kept) : "look_changed";

    store.forgetLook(taskId);
    if (failed) {
      if (failed !== "look_changed") log?.warn?.(`[program-card] kept layout not put back task=${taskId} code=${failed}`);
      return false;
    }
    log?.info(`[program-card] layout back task=${taskId} card=${cardId} layout=${kept.templateId}`);
    return true;
  }

  return { keep, undo, restore };
}

module.exports = { createTaskCardLookUndo };
