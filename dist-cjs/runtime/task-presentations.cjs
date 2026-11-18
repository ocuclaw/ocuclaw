const { createTaskPresentationStore, TaskPresentationError } = require("../tools/task-presentation-store.cjs");
const { liveuiLibraryDigest } = require("../tools/glasses-ui-library.cjs");
const { compileStoredSurfaceRecords, fillStoredSurface } = require("../tools/liveui-compiler/stored-surface.cjs");
const { hermesProfileIdForNamespace } = require("./hermes-session-keys.cjs");

function taskPresentationLibraryName(title        , taskName         ) {
  const base = title.trim().slice(0, 51).trimEnd();
  const result = `${base} · Result`;
  return result.toLocaleLowerCase() === taskName?.trim().toLocaleLowerCase() ? `${base} · Card` : result;
}

function createTaskPresentations(deps     ) {
  const active = new Set        ();
  const previews = new Map                                                   ();
  function cancel(clientId        , requestId         ) {
    const entry = previews.get(clientId);
    if (!entry || requestId && entry.requestId !== requestId) return false;
    entry.cancelled = true;
    return true;
  }
  function scope(clientId        ) {
    const context = deps.context(clientId);
    if (!context || !context.clientId || !deps.current(context)) throw new TaskPresentationError("presentation_owner_changed");
    return { context, store: createTaskPresentationStore(deps.stateDir, context.ownerKey) };
  }
  function exact(store     , reference     ) {
    const record = store.read(reference.proposalId);
    if (record.digest !== reference.digest) throw new TaskPresentationError("presentation_conflict");
    return record;
  }
  function failure(e     ) { return { status: "rejected", code: e.code || "presentation_unavailable" }; }
  const ref = (record     ) => ({ proposalId: record.proposalId, digest: record.digest });
  function keep(clientId        , candidate     ) {
    const { store } = scope(clientId);
    const record = store.create(candidate);
    return { ...candidate, ...ref(record) };
  }
  function revision(clientId        , taskId        ) {
    try {
      const { context, store } = scope(clientId);
      const next = deps.revisionCandidate(context, taskId);
      if (!next?.candidate) throw new TaskPresentationError(next?.code || "presentation_unavailable");
      const record = store.create(next.candidate, next.target);
      return { status: "ready", candidate: { ...next.candidate, ...ref(record) } };
    } catch (e     ) { return failure(e); }
  }
  async function applyRevision(clientId        , reference     ) {
    let key = "", acquired = false;
    try {
      const { context, store } = scope(clientId);
      const record = exact(store, reference);
      if (!record.revisionTarget || !["prepared", "saving", "saved"].includes(record.phase))
        throw new TaskPresentationError("presentation_preview_required");
      key = `${context.ownerKey}:${record.proposalId}`;
      if (active.has(key)) throw new TaskPresentationError("presentation_busy");
      active.add(key); acquired = true;
      const result = await deps.applyRevision(context, record.revisionTarget);
      if (result?.status !== "saved") return result;
      store.transition(record.proposalId, record.digest, ["prepared", "saving", "saved"], { phase: "saved", saved: result });
      return result;
    } catch (e     ) { return failure(e); }
    finally { if (acquired) active.delete(key); }
  }
  async function preview(clientId        , reference     ) {
    let key = "";
    let acquired = false;
    const entry = { requestId: reference.requestId || "", cancelled: false };
    try {
      if (previews.has(clientId)) throw new TaskPresentationError("presentation_busy");
      const { context, store } = scope(clientId);
      let record = exact(store, reference);
      if (record.revisionTarget && !deps.revisionCurrent(context, record.revisionTarget))
        throw new TaskPresentationError("presentation_revision_changed");
      key = `${context.ownerKey}:${record.proposalId}`;
      if (active.has(key)) throw new TaskPresentationError("presentation_busy");
      active.add(key);
      acquired = true;
      previews.set(clientId, entry);
      if (record.phase === "preparing") throw new TaskPresentationError("preview_outcome_unknown");
      if (record.phase === "proposed") {

        store.transition(record.proposalId, record.digest, ["proposed"], { phase: "preparing" });
        let draft      = null;
        if (record.candidate.presentation.kind === "program" && !record.revisionTarget) {
          draft = await deps.drafts.prepare(context.sessionKey, context.clientId,
            { title: record.candidate.title, source: record.candidate.presentation.source });
          if (!draft?.ok) {
            store.transition(record.proposalId, record.digest, ["preparing"], { phase: "failed", failure: draft?.error || "preview_failed" });
            throw new TaskPresentationError(draft?.error || "preview_failed");
          }
        }
        record = store.transition(record.proposalId, record.digest, ["preparing"], { phase: "prepared", ...(draft ? { draft } : {}) });
      }
      if (!["prepared", "saving", "saved"].includes(record.phase)) throw new TaskPresentationError(record.failure || "preview_failed");
      if (record.draft) {
        const current = await deps.drafts.run(context.sessionKey, { action: "get", draftId: record.draft.draftId }, context.clientId);
        if (!current?.ok || current.revision !== record.draft.revision || current.checkpointSeq !== record.draft.checkpointSeq ||
            current.sourceHash !== record.draft.sourceHash) throw new TaskPresentationError("presentation_revision_changed");
      }
      if (entry.cancelled) throw new TaskPresentationError("presentation_cancelled");
      if (!deps.current(context)) throw new TaskPresentationError("presentation_owner_changed");
      const presentation = record.candidate.presentation;
      let previewSurface     ;
      if (presentation.kind === "surface") {
        const compiled = compileStoredSurfaceRecords(presentation.records, { inputs: presentation.inputs });
        if (!compiled.ok) throw new TaskPresentationError("presentation_invalid");
        previewSurface = { v: 2, vocab: compiled.vocab,
          ...fillStoredSurface(compiled.surface, presentation.sample, presentation.inputs), data: presentation.sample };
      }
      return { status: "prepared", candidate: { ...record.candidate, ...ref(record), ...(previewSurface ? { previewSurface } : {}) },
        ...(record.draft ? { draft: record.draft } : {}) };
    } catch (e     ) { return failure(e); }
    finally { if (acquired) active.delete(key); if (previews.get(clientId) === entry) previews.delete(clientId); }
  }
  async function save(clientId        , input     , perform     ) {
    let key = "";
    let acquired = false;
    try {
      const { context, store } = scope(clientId);
      let record = exact(store, input.presentation);
      if (record.revisionTarget) throw new TaskPresentationError("presentation_revision_only");
      key = `${context.ownerKey}:${record.proposalId}`;
      if (active.has(key)) throw new TaskPresentationError("presentation_busy");
      active.add(key);
      acquired = true;
      if (record.candidate.request !== input.request || input.starter || input.fromJob)
        throw new TaskPresentationError("presentation_work_changed");
      const saveInputDigest = liveuiLibraryDigest(input);
      if (record.saveInputDigest && record.saveInputDigest !== saveInputDigest) throw new TaskPresentationError("presentation_approval_changed");
      if (record.phase === "saved") return deps.taskExists(record.taskId) ? record.saved
        : failure(new TaskPresentationError("presentation_task_missing"));
      if (!["prepared", "saving"].includes(record.phase)) throw new TaskPresentationError("presentation_preview_required");
      const presentation = record.candidate.presentation;
      const presentationName = taskPresentationLibraryName(record.candidate.title, input.name);
      let savedCard      = null;
      if (presentation.kind === "program") {
        const draft = await deps.drafts.run(context.sessionKey, { action: "get", draftId: record.draft?.draftId }, context.clientId);
        if (!draft?.ok || draft.revision !== record.draft.revision || draft.checkpointSeq !== record.draft.checkpointSeq ||
            draft.sourceHash !== record.draft.sourceHash) throw new TaskPresentationError("presentation_revision_changed");

        savedCard = deps.drafts.promote(context.sessionKey, context.clientId,
          { draft, card: draft.card, state: draft.state, name: presentationName, by: "owner" });
        if (savedCard?.status !== "saved") throw new TaskPresentationError(savedCard?.code || "presentation_save_failed");
      }
      if (!deps.current(context)) throw new TaskPresentationError("presentation_owner_changed");
      const taskId = record.taskId || `setup-${record.proposalId}`;
      const allowCreate = record.phase === "prepared";
      record = store.transition(record.proposalId, record.digest, ["prepared", "saving"], { phase: "saving", taskId, saveInputDigest });

      const result = await perform({ ...input, presentation: undefined }, {

        agentId: context.owner.backend === "hermes"
          ? hermesProfileIdForNamespace(context.owner.agent) : context.owner.agent,
        taskId, allowCreate,
        beforeApprove: (version     ) => deps.bind({ taskId, version, presentation, savedCard, owner: context.owner,
          sourceHash: record.draft?.sourceHash, title: savedCard?.name || presentationName }),
      });
      if (result?.status === "saved") store.transition(record.proposalId, record.digest, ["saving"], { phase: "saved", saved: result });
      return result;
    } catch (e     ) { return failure(e); }
    finally { if (acquired) active.delete(key); }
  }
  return { keep, preview, save, cancel, revision, applyRevision };
}

module.exports = { taskPresentationLibraryName, createTaskPresentations };
