const TASK_FIX_UNDO_CODES = Object.freeze({
  notBound: "card_not_bound",
  gone: "fix_undo_gone",
  changed: "card_changed",
  busy: "fix_undo_busy",
  restoreFailed: "card_save_failed",
  linkFailed: "binding_save_failed",
});

function createTaskFixUndo(deps     ) {
  const active = new Set        ();
  const rejected = (code        ) => ({ status: "rejected", code });

  async function undo(clientId        , taskId        ) {
    const binding      = deps.binding(taskId);
    if (binding?.schemaVersion !== 2 || !deps.owns(clientId, binding)) return rejected(TASK_FIX_UNDO_CODES.notBound);
    if (active.has(binding.cardId)) return rejected(TASK_FIX_UNDO_CODES.busy);
    active.add(binding.cardId);
    try {
      return await undoIn(taskId, binding);
    } finally {
      active.delete(binding.cardId);
    }
  }

  async function undoIn(taskId        , binding     ) {
    const fixed = binding.fixed;
    if (!fixed || !deps.open(fixed)) return rejected(TASK_FIX_UNDO_CODES.gone);
    const cardId = binding.cardId;
    const source      = deps.source(cardId);
    const others = (Array.isArray(fixed.others) ? fixed.others : []).map((entry     ) => ({ entry, binding: deps.binding(entry.taskId) }));
    const moved = source?.status === "accepted" && source.revision === fixed.toRevision && binding.revision === fixed.toRevision &&
      binding.sourceHash === source.sourceHash &&
      others.every((other     ) => other.binding?.schemaVersion === 2 && other.binding.cardId === cardId &&
        other.binding.revision === fixed.toRevision);
    if (!moved) {

      try { deps.close(taskId); } catch (_) {  }
      deps.log(`[program-card] fix undo refused card=${cardId} task=${taskId} code=card_changed`);
      return rejected(TASK_FIX_UNDO_CODES.changed);
    }
    if (!deps.hasRevision(cardId, fixed.revision)) return rejected(TASK_FIX_UNDO_CODES.gone);

    const restored      = deps.restore(cardId, fixed.revision);
    if (restored?.status !== "restored") return rejected(typeof restored?.code === "string" ? restored.code : TASK_FIX_UNDO_CODES.restoreFailed);
    const after      = deps.source(cardId);
    let linked      = null;
    try {
      linked = after?.status === "accepted" && after.revision === fixed.revision
        ? deps.undoLink(taskId, { revision: fixed.revision, sourceHash: after.sourceHash, inputs: fixed.inputs,
          ...(fixed.last ? { last: fixed.last } : {}) })
        : rejected(TASK_FIX_UNDO_CODES.restoreFailed);
      for (const other of others) {
        if (linked?.status !== "accepted") break;
        linked = deps.repinOne(other.entry.taskId, fixed.revision, after.sourceHash);
      }
    } catch (_) {
      linked = rejected(TASK_FIX_UNDO_CODES.linkFailed);
    }
    if (linked?.status !== "accepted") {
      for (const back of [binding, ...others.map((other     ) => other.binding)]) {
        try { deps.rewrite(back); } catch (_) {  }
      }
      try { deps.restore(cardId, fixed.toRevision); } catch (_) {  }
      deps.log(`[program-card] fix undo rolled back card=${cardId} task=${taskId} code=${linked?.code || "unknown"}`);
      return rejected(typeof linked?.code === "string" ? linked.code : TASK_FIX_UNDO_CODES.linkFailed);
    }
    deps.log(`[program-card] fix undone card=${cardId} task=${taskId} revision=${fixed.revision}`);
    const result = { status: "undone", cardId, cardName: typeof source.name === "string" ? source.name : cardId, revision: fixed.revision };
    try { deps.done(result); } catch (_) {  }
    try { await deps.resend([taskId, ...others.map((other     ) => other.entry.taskId)]); } catch (_) {  }
    return result;
  }

  return { undo };
}

module.exports = { TASK_FIX_UNDO_CODES, createTaskFixUndo };
