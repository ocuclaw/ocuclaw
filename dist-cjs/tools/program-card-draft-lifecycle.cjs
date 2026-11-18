const { randomUUID } = require("node:crypto");
const { ProgramCardDraftError } = require("./program-card-draft-store.cjs");

function createProgramCardDraftLifecycle(deps                            ) {
  const approvals = new Map                                                                           ();
  const editing = new Set        ();
  const keyOf = (binding              , id        ) => JSON.stringify([binding.ownerKey, id]);
  const assertCurrent = (binding              ) => {
    if (!binding.ownerKey || !binding.sessionKey || !binding.clientId || !deps.isCurrent(binding))
      throw new ProgramCardDraftError("client_changed");
  };
  function invalidate(binding              , id        ) {
    const key = keyOf(binding, id);
    const pending = approvals.get(key);
    if (!pending) return;
    pending.cancelled = true;
    approvals.delete(key);
    deps.cancelApproval(pending.requestKey);
  }
  function readExpected(binding              , id        , expected                         ) {
    const record = deps.store(binding).read(id);
    if (!record) throw new ProgramCardDraftError("not_found");
    if (record.revision !== expected?.revision || record.checkpointSeq !== expected?.checkpointSeq)
      throw new ProgramCardDraftError("conflict");
    if (record.promotion) throw new ProgramCardDraftError("promotion_pending_or_saved");
    return record;
  }

  async function create(binding              , input                          , base                       , origin              ) {
    assertCurrent(binding);
    const accepted = await deps.validate(binding, input);
    assertCurrent(binding);
    return capture(binding, accepted, base, origin);
  }

  function capture(binding              , accepted                          , base                       , origin              ) {
    assertCurrent(binding);
    const store = deps.store(binding);
    const before = store.list().filter(r => r.promotion?.status !== "saved");
    try { return store.create(accepted, base, origin); }
    finally {

      for (const record of before) {
        if (!store.read(record.draftId)) {
          invalidate(binding, record.draftId);
          deps.removed?.(binding, record.draftId, "evicted");
        }
      }
    }
  }
  async function edit(binding              , id        , expected                         , edit         ) {
    assertCurrent(binding);
    const record = readExpected(binding, id, expected);
    const key = keyOf(binding, id);
    if (editing.has(key)) throw new ProgramCardDraftError("edit_pending");
    editing.add(key);
    try {

      invalidate(binding, id);
      const accepted = await deps.validate(binding, record, edit);
      assertCurrent(binding);
      return deps.store(binding).edit(id, expected, accepted);
    } finally { editing.delete(key); }
  }
  async function launch(binding              , id        , expected                         ) {
    assertCurrent(binding);
    const record = readExpected(binding, id, expected);
    const key = keyOf(binding, id);
    if (editing.has(key)) throw new ProgramCardDraftError("edit_pending");
    if (approvals.has(key)) throw new ProgramCardDraftError("approval_pending");
    const pending = { requestKey: `draft-launch-${randomUUID()}`, binding: { ...binding }, cancelled: false };
    approvals.set(key, pending);
    try {
      const result = await deps.approve(binding, record, pending.requestKey);
      if (pending.cancelled) return { ok: false, shown: false, error: "cancelled" };
      if (result.answer !== "yes") return { ok: false, shown: false, error: result.answer === "no" ? "declined" : "cancelled" };
      assertCurrent(binding);
      const latest = readExpected(binding, id, expected);
      return await deps.display(binding, latest, pending.requestKey);
    } finally { if (approvals.get(key) === pending) approvals.delete(key); }
  }
  function checkpoint(binding              , id        , expected                         , state         ) {
    assertCurrent(binding);
    const updated = deps.store(binding).checkpoint(id, expected, state);
    invalidate(binding, id);
    return updated;
  }
  function acceptSnapshot(binding              , id        , expected                         , snapshot                          ) {
    assertCurrent(binding);
    const updated = deps.store(binding).edit(id, expected, snapshot);
    invalidate(binding, id);
    return updated;
  }
  function discard(binding              , id        , expected                         ) {
    const removed = deps.store(binding).discard(id, expected);
    invalidate(binding, id);
    deps.removed?.(binding, id, "discarded");
    return removed;
  }
  function cancelClient(clientId        ) {
    for (const [key, pending] of approvals) {
      if (pending.binding.clientId !== clientId) continue;
      pending.cancelled = true; approvals.delete(key); deps.cancelApproval(pending.requestKey);
    }
  }
  function dispose() {
    for (const pending of approvals.values()) {
      pending.cancelled = true; deps.cancelApproval(pending.requestKey);
    }
    approvals.clear();
  }
  return { create, capture, edit, launch, checkpoint, acceptSnapshot, discard, invalidate, cancelClient, dispose };
}

module.exports = { createProgramCardDraftLifecycle };
