const TASK_FIX_SAVE_CODES = Object.freeze({
  notRunning: "fix_not_running",
  notReady: "fix_not_ready",
  changed: "card_changed",
  taskChanged: "task_changed",
  notChecked: "fix_not_checked",
  notFits: "fix_not_fits",
  stale: "fix_check_stale",
  newerRun: "fix_newer_run_unfit",
  busy: "fix_save_busy",
  saveFailed: "card_save_failed",
  linkFailed: "binding_save_failed",
});

function createTaskFixSave(deps     ) {
  const active = new Set        ();
  const rejected = (code        ) => ({ status: "rejected", code });

  async function save(clientId        , taskId        , handle         ) {
    const fix      = typeof handle === "string" ? deps.fixOf(taskId, handle) : null;
    if (!fix || fix.clientId !== clientId) return rejected(TASK_FIX_SAVE_CODES.notRunning);

    if (fix.savedResult) return fix.savedResult;
    if (active.has(fix.cardId)) return rejected(TASK_FIX_SAVE_CODES.busy);
    active.add(fix.cardId);
    try {
      return await saveIn(clientId, taskId, fix);
    } finally {
      active.delete(fix.cardId);
    }
  }

  async function saveIn(clientId        , taskId        , fix     ) {
    const end = deps.buildEnd(fix.handle);
    if (!end || end.outcome !== "draft" || typeof end.draftId !== "string") return rejected(TASK_FIX_SAVE_CODES.notReady);
    const binding = deps.binding(taskId);
    if (binding?.schemaVersion !== 2 || !deps.owns(clientId, binding)) return rejected(TASK_FIX_SAVE_CODES.notRunning);

    if (binding.cardId !== fix.cardId || binding.revision !== fix.revision || binding.sourceHash !== fix.sourceHash)
      return rejected(TASK_FIX_SAVE_CODES.changed);
    if (!deps.current(binding)) return rejected(TASK_FIX_SAVE_CODES.taskChanged);
    const source      = deps.source(fix.cardId);
    if (source?.status !== "accepted" || source.revision !== fix.revision || source.sourceHash !== fix.sourceHash)
      return rejected(TASK_FIX_SAVE_CODES.changed);
    const draft      = await deps.draft(end.sessionKey, end.draftId);
    if (!draft?.ok || typeof draft.card?.source !== "string") return rejected(TASK_FIX_SAVE_CODES.notReady);
    if (draft.base?.appId !== fix.cardId) return rejected(TASK_FIX_SAVE_CODES.changed);

    const check = fix.check;
    if (!check) return rejected(TASK_FIX_SAVE_CODES.notChecked);
    if (check.verdict !== "fits") return rejected(TASK_FIX_SAVE_CODES.notFits);
    if (check.sourceHash !== deps.digest(draft.card.source)) return rejected(TASK_FIX_SAVE_CODES.stale);

    const kept = binding.fix?.kept;
    if (kept && Number.isSafeInteger(kept.atMs) && kept.atMs > fix.atMs) {
      const pick      = deps.pick(binding, fix.key);
      if (pick?.status !== "accepted" || pick.change !== fix.change) return rejected(TASK_FIX_SAVE_CODES.newerRun);
    }
    const values = deps.values(fix.inputs, binding.last, kept, fix.key);
    if (binding.last && !values) return rejected(TASK_FIX_SAVE_CODES.newerRun);
    const table = deps.table(source, binding, fix.inputs);
    const previous = deps.card(fix.cardId);
    if (!table || !previous) return rejected(TASK_FIX_SAVE_CODES.changed);

    const fixed = { task: fix.taskName, key: fix.key, ...(fix.label ? { label: fix.label } : {}), change: fix.change };
    const card      = deps.promote(end.sessionKey, clientId, { draft, card: draft.card, state: draft.state,
      name: fix.cardName, by: "owner", mode: "revision" }, table, { fixed, prune: false });
    if (card?.status !== "saved" || !Number.isSafeInteger(card.revision))
      return rejected(typeof card?.code === "string" ? card.code : TASK_FIX_SAVE_CODES.saveFailed);
    const after      = deps.source(fix.cardId);
    const others        = deps.others(fix.cardId, taskId) || [];

    let linked     ;
    try {
      linked = after?.status === "accepted" && after.revision === card.revision
        ? deps.applyFix(taskId, { revision: card.revision, sourceHash: after.sourceHash, inputs: fix.inputs,
          values: values || undefined,
          fixed: { atMs: deps.now(), key: fix.key, change: fix.change, toRevision: card.revision, revision: binding.revision,
            sourceHash: binding.sourceHash, inputs: binding.inputs, ...(binding.last ? { last: binding.last } : {}),

            tries: Number.isSafeInteger(binding.fix?.tries?.count) ? binding.fix.tries.count : 0,
            ...(others.length ? { others: others.map((other     ) => ({ taskId: other.taskId, revision: other.revision,
              sourceHash: other.sourceHash })) } : {}) } })
        : rejected(TASK_FIX_SAVE_CODES.changed);

      if (linked?.status === "accepted" && others.length) {
        const moved      = deps.repin(fix.cardId, card.revision, after.sourceHash, table, taskId);
        if (!moved || (Array.isArray(moved.failed) && moved.failed.length)) linked = rejected(TASK_FIX_SAVE_CODES.linkFailed);
      }
    } catch (_) {
      linked = rejected(TASK_FIX_SAVE_CODES.linkFailed);
    }
    if (linked?.status !== "accepted") {
      rollback([binding, ...others], previous, card.revision, end);
      deps.log(`[program-card] fix save rolled back card=${fix.cardId} task=${taskId} code=${linked?.code || "unknown"}`);
      return rejected(typeof linked?.code === "string" ? linked.code : TASK_FIX_SAVE_CODES.linkFailed);
    }
    deps.log(`[program-card] fix saved card=${fix.cardId} task=${taskId} ${fix.key}:${fix.change} revision=${card.revision}`);

    try { deps.prune(fix.cardId); } catch (_) {  }
    const result = { status: "saved", cardId: fix.cardId, cardName: fix.cardName, revision: card.revision, key: fix.key,
      ...(fix.label ? { label: fix.label } : {}), change: fix.change, draftId: end.draftId, sourceHash: after.sourceHash };
    fix.savedResult = result;
    try { deps.saved(fix, result); } catch (_) {  }

    try { await deps.resend([taskId, ...others.map((other     ) => other.taskId)]); } catch (_) {  }
    return result;
  }

  function rollback(bindings       , previous     , number        , end     ) {
    for (const step of [...bindings.map((binding) => () => deps.restore(binding)), () => deps.undoRevision(previous, number),
      () => deps.unpromote(end.sessionKey, end.draftId, bindings[0].cardId)]) {
      try { step(); } catch (_) {  }
    }
  }

  return { save };
}

module.exports = { TASK_FIX_SAVE_CODES, createTaskFixSave };
