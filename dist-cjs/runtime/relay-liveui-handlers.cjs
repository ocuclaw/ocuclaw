const { forgetPlanIconForSource, normalizeProgramCardErrorCode, planIconForSource, programCardAsksForSave, programCardDescriptionForSource, programCardSaveRequestDescription, resolveProgramCardSaveRequest } = require("../tools/program-card-saves.cjs");
const { PROGRAM_CARD_KIT_TOO_NEW, programCardKitTooNew } = require("../tools/program-card-kit-check.cjs");
const { linkedCardParts, relinkCardParts } = require("../tools/glasses-ui-card-part-add.cjs");
const { formatProgramCardOpen } = require("./downstream-codec-liveui.cjs");

function createRelayLiveuiHandlers(ctx                            ) {
  const {
    resolveLiveuiGlassesLibraryController,
    programCardSaves,
    privateCardAccess,
    programCardReviewer,
    cardIconPicker,
    logger,
    followCardRevision,
    programCardFrameRedo,
    libraryWithCardKits,
    pushBindingsIfTaskCard,
    clearGlassesUiSurfacesOnly,
    sessionService,
    taskPresentationClientOwns,
    cardDrafts,
    cardBuildPhases,
    clientKitLevel,
    reconcileRepinned,
    programCardUndoRevisions,
    cardStudio,
    noteCardReviewEvent,
    cardReviewRetryOwner,
    noteCardAcceptTest,
    noteCardAccept,
    listLiveuiTaskExecutors,
    pushProgramCardBindings,
    liveUiVideoRoute,
  } = ctx;

  return {
    onGetLiveuiLibrary() {
      const controller = resolveLiveuiGlassesLibraryController();
      const items = controller ? controller.listLibrary() : [];

      Promise.resolve(items).then((list     ) => cardIconPicker.backfill(list)).catch(() => {});

      return items && typeof items.then === "function" ? items.then(libraryWithCardKits) : libraryWithCardKits(items);
    },

    onOpenLiveuiLibraryItem({ clientId, itemType, itemId, resultId }     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return { itemType, itemId, status: "rejected", code: "item_unavailable" };
      }
      return controller.openLibraryItem({
        clientId,
        itemType,
        itemId,
        ...(typeof resultId === "string" ? { resultId } : {}),
        sessionKey: sessionService.ensureSessionKey(),
        origin: "glasses",
        taskRunController: ctx.liveuiTaskRunController,
      });
    },

    onSaveProgramCard(request     ) {
      if (request?.appId && !privateCardAccess(request.clientId, request.appId))
        return { status: "rejected", code: "presentation_owner_changed", appId: request.appId };
      const sourceOwner = request?.sourceAppId && ctx.programCardFeed?.store.ownerScope(request.sourceAppId);
      if (sourceOwner && (!taskPresentationClientOwns(request.clientId, { ownerScope: sourceOwner }) ||
          request.appId && ctx.programCardFeed.store.ownerScope(request.appId) !== sourceOwner))
        return { status: "rejected", code: "presentation_owner_changed", appId: request.appId || "" };
      const requestId = request && typeof request.requestId === "string" ? request.requestId : "";

      const card = request && request.card;
      const description = programCardSaveRequestDescription(requestId) ||
        (card && card.kind === "source" ? programCardDescriptionForSource(card.source) : null);
      const asks = card?.kind === "source" ? programCardAsksForSave(request.clientId,
        ctx.server?.getClientSessionKey?.(request.clientId), card.source, globalThis, request.draft?.draftId ?? null) : null;
      const result      = request && request.error !== undefined
        ? {
            status: "rejected",
            code: normalizeProgramCardErrorCode(request.error),
            appId: typeof request.appId === "string" ? request.appId : "",
            name: typeof request.name === "string" ? request.name.trim() : "",
          }
        : request?.draft ? (cardDrafts?.promote(ctx.server.getClientSessionKey(request.clientId), request.clientId,
          { ...request, ...(description ? { description } : {}), ...(asks ? { asks } : {}) }) || { status: "rejected", code: "draft_unavailable" })
        : programCardSaves.save({ ...(request || {}), ...(description ? { description } : {}), ...(asks ? { asks } : {}) }, sourceOwner ? {
          beforeCreate: (newId        ) => ctx.programCardFeed.store.claimCard(newId, sourceOwner).status === "accepted",
        } : {});
      if (result.status === "saved") {

        const planned = card?.kind === "source" ? planIconForSource(card.source) : null;
        if (planned) {
          cardIconPicker.stamp(result.appId, planned);
          forgetPlanIconForSource(card.source);
        }
        cardIconPicker.schedule(result.appId);

        const tests = cardBuildPhases.testsFor(ctx.server?.getClientSessionKey?.(request.clientId));
        if (tests && Number.isSafeInteger(result.revision)) {
          try {
            programCardSaves.noteRevisionSeen({ appId: result.appId, number: result.revision,
              tests: tests.map((test     ) => ({ requirement: test.line, verdict: test.verdict })) });
          } catch (err     ) {
            logger.warn(`[relay] revision tests not kept: ${err && err.message ? err.message : err}`);
          }
        }
      }
      const answer = {
        status: result.status,
        appId: result.appId,
        name: result.name,
        ...(result.status === "saved" && Number.isSafeInteger(result.revision) ? { revision: result.revision } : {}),
        ...(result.status === "saved" ? { sourceHash: programCardSaves.source({ appId: result.appId }).sourceHash } : {}),
        ...(result.status === "saved" && Array.isArray(result.dropped) ? { dropped: result.dropped } : {}),
        ...(result.status !== "saved" && result.code ? { code: result.code } : {}),
      };

      const agentAsked = resolveProgramCardSaveRequest(requestId, { requestId, ...answer }) || request?.by === "agent";

      if (result.status === "saved" && agentAsked) pushBindingsIfTaskCard(result.appId);
      else if (result.status === "saved") followCardRevision(result.appId, "save");
      return answer;
    },

    onCheckpointProgramCard(request     ) {
      if (!privateCardAccess(request.clientId, request.appId))
        return { status: "rejected", code: "presentation_owner_changed", appId: request.appId, seq: request.seq };
      return programCardSaves.checkpoint(request || {});
    },

    onOpenProgramCard({ clientId, appId }     ) {

      if (!privateCardAccess(clientId, appId)) return { status: "rejected", code: "presentation_owner_changed", appId };
      const result      = programCardSaves.open({ appId });

      if (result.status === "accepted" && programCardKitTooNew(result.open.kit?.level, clientKitLevel(clientId)))
        return { status: "rejected", code: PROGRAM_CARD_KIT_TOO_NEW, appId };

      const emptiedAtMs = result.status === "accepted" ? ctx.programCardFeed?.store.partsEmptiedAtMs(appId) : null;
      if (emptiedAtMs && result.open.state != null &&
          !(Number.isSafeInteger(result.open.savedAtMs) && result.open.savedAtMs > emptiedAtMs))
        result.open.fresh = true;
      if (result.status === "accepted" && ctx.programCardFeed?.store.ownerScope(appId)) {
        ctx.server.unicast(clientId, formatProgramCardOpen(result.open));
        return { ...result, deliveredPrivately: true };
      }
      return result;
    },

    onGetProgramCardSource({ clientId, appId }     ) {
      if (!privateCardAccess(clientId, appId)) return { status: "rejected", code: "presentation_owner_changed", appId };
      return programCardSaves.source({ appId });
    },

    onGetProgramCardRevisions({ appId }     ) {

      return programCardFrameRedo.decorate(programCardSaves.listRevisions({ appId }));
    },

    onProgramCardRevision({ clientId, action, appId, number, name, requestId, style, frameLayout, detail }     ) {
      if (!privateCardAccess(clientId, appId)) return { status: "rejected", code: "presentation_owner_changed", appId };

      if (action === "frame_redraw") return { appId, ...programCardFrameRedo.redraw({ appId, requestId: requestId ?? "", style, frameLayout, detail }) };
      let result     ;

      if (action === "restore") {
        result = programCardSaves.restoreRevision({ appId, number,
          linkedParts: ctx.programCardFeed ? linkedCardParts(ctx.programCardFeed.store, appId) : [] });

        if (result?.status === "restored" && ctx.programCardFeed) {
          const source      = programCardSaves.source({ appId });
          const table = source?.status === "accepted" && source.revision === number && Array.isArray(source.taskSlots) ? source.taskSlots : null;
          if (table) {
            const relinked = relinkCardParts(ctx.programCardFeed.store, appId, source.revision, source.sourceHash, table);
            if (relinked.failed.length) logger.warn(`[program-card] make current relink failed card=${appId} tasks=${relinked.failed.length}`);
            if (relinked.relinked.length) {
              logger.info(`[program-card] make current relinked card=${appId} revision=${number} tasks=${relinked.relinked.length}`);
              void reconcileRepinned(relinked.relinked);
            }
          }
        }
      }

      else if (action === "delete") return programCardUndoRevisions(appId).includes(number)
        ? { status: "rejected", code: "revision_kept_for_undo", appId, number }
        : programCardSaves.deleteRevision({ appId, number });
      else if (action === "fork") {
        const ownerScope = ctx.programCardFeed?.store.ownerScope(appId);
        result = programCardSaves.forkRevision({ appId, number, name, ...(ownerScope ? {
          beforeCreate: (newId        ) => ctx.programCardFeed.store.claimCard(newId, ownerScope).status === "accepted",
        } : {}) });
      }
      else if (action === "rename") result = programCardSaves.renameCard({ appId, name });
      else if (action === "frame_remove") result = { appId, ...programCardFrameRedo.remove({ appId }) };
      else return { status: "rejected", code: "action_invalid", appId };

      if (result && ["restored", "saved", "renamed"].includes(result.status)) cardIconPicker.schedule(result.appId || appId);

      if (action === "frame_remove" && result?.status === "saved") followCardRevision(appId, "frame_remove");

      else if (result && ["restored", "saved"].includes(result.status)) pushBindingsIfTaskCard(result.appId || appId);
      return result;
    },

    onProgramCardReview({ clientId, op, appId, source, speed, look, asks, reviewFocus, controls, reviewId, candidateId, ideaId, decision, attemptId, step, label, png }     ) {
      if (!privateCardAccess(clientId, appId)) return { status: "rejected", code: "presentation_owner_changed", appId };
      if (op === "start") {

        if (typeof appId === "string" && appId) cardStudio.touch({ kind: "card", id: `app:${appId}`, why: "reviewed" });
        const started = programCardReviewer.start({ appId, source, speed, look, asks, reviewFocus, controls });

        if (started && typeof started.code === "string") noteCardReviewEvent(appId, "card_review_refused", { op, code: started.code });
        return started;
      }
      if (op === "look_step") return programCardReviewer.lookStep({ appId, reviewId, step, label, png });
      if (op === "cancel") return programCardReviewer.cancel({ appId, reviewId, candidateId });

      const owner = cardReviewRetryOwner(clientId);
      if (op === "retry") return programCardReviewer.retryIdea({ appId, reviewId, ideaId, ...owner });
      if (op === "retry_cancel") return programCardReviewer.cancelRetry({ appId, reviewId, ideaId, attemptId, ...owner });
      if (op === "decide") return programCardReviewer.decide({ appId, reviewId, ideaId, decision });
      return programCardReviewer.get({ appId });
    },

    onProgramCardReviewApply(request     ) {
      if (!privateCardAccess(request.clientId, request.appId)) return { status: "rejected", code: "presentation_owner_changed", appId: request.appId };
      const startedAt = Date.now();
      noteCardAcceptTest(request);
      const applied = programCardReviewer.apply(request || {});
      Promise.resolve(applied).then((result     ) => {
        noteCardAccept(request, result, startedAt);

        if (result?.status === "saved") followCardRevision(request.appId, "review_accept");
      }, () => {});
      return applied;
    },

    onProgramCardRevisionPicture({ clientId, appId, number, png }     ) {
      if (!privateCardAccess(clientId, appId)) return { status: "rejected", code: "presentation_owner_changed", appId };
      return programCardSaves.noteRevisionSeen({ appId, number, picture: png });
    },

    onCancelLiveuiTaskLaunch({ clientId, taskId }     ) {
      if (!ctx.liveuiTaskRunController) return false;
      return ctx.liveuiTaskRunController.cancelTaskLaunch({ clientId, taskId });
    },

    onGetLiveuiTasksForPhone() {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller
        ? controller.listTasksForPhone()
        : { tasks: [], templates: [], invalid: [] };
    },

    onGetLiveuiTaskRunsForPhone(taskId     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      return controller && typeof controller.listTaskRunRecords === "function"
        ? controller.listTaskRunRecords(taskId)
        : [];
    },

    onGetLiveuiTaskExecutors() {
      return listLiveuiTaskExecutors();
    },

    onSetLiveuiTaskExecutor({ taskId, executor }     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      return controller.updateTaskExecutor(taskId, executor);
    },

    onSetLiveuiTaskSettingValues({ taskId, expectedDigest, values }     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.updateTaskSettingValues !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      return controller.updateTaskSettingValues(taskId, values, { expectedDigest });
    },

    onSetLiveuiTaskPreferredTemplate({ taskId, expectedDigest, templateId }     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.updateTaskPreferredTemplate !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      return controller.updateTaskPreferredTemplate({ taskId, expectedDigest, templateId });
    },

    onReviewLiveuiTask({ taskId, action, expectedDigest, cardLinkDigest }     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return { taskId, action, status: "rejected", code: "item_unavailable" };
      }
      return Promise.resolve(controller.reviewTask({
        taskId,
        action,
        expectedDigest,
        ...(typeof cardLinkDigest === "string" ? { cardLinkDigest } : {}),
      })).then((result     ) => {

        if (result && result.status === "accepted" && (action === "approve" || action === "reject") && ctx.programCardFeed) {
          pushProgramCardBindings();
        }
        return result;
      });
    },

    onSetLiveuiTaskContext({ taskId, context }     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.updateTaskContext !== "function") {
        return { taskId, status: "rejected", code: "item_unavailable" };
      }
      const result = controller.updateTaskContext(taskId, context);
      return result && result.status === "saved"
        ? { taskId, status: "accepted" }
        : {
          taskId,
          status: "rejected",
          code: result && typeof result.code === "string"
            ? result.code
            : "task_context_update_failed",
        };
    },

    onGetLiveuiPrefs() {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.getLiveuiPrefs !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return controller.getLiveuiPrefs();
    },

    onSetLiveuiPrefs({ patch }     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.setLiveuiPrefs !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      const result      = controller.setLiveuiPrefs(patch);

      if (result && result.status === "accepted" && Array.isArray(result.clearedSessionKeys)) {
        for (const sessionKey of result.clearedSessionKeys) {
          clearGlassesUiSurfacesOnly(sessionKey, "liveui_disabled");
        }
      }
      return result;
    },

    onGetLiveuiGrants() {
      const publicApi = resolveLiveuiGlassesLibraryController();
      if (!publicApi || typeof publicApi.liveuiGrantsSnapshot !== "function") {
        return { status: "rejected", code: "item_unavailable" };
      }
      return publicApi.liveuiGrantsSnapshot();
    },

    onSetLiveuiGrant({ action, host, baseDigest }     ) {
      const publicApi = resolveLiveuiGlassesLibraryController();
      if (!publicApi || typeof publicApi.applyLiveuiGrantIntent !== "function") {
        return { action, host, status: "rejected", code: "item_unavailable" };
      }
      const scheduleSessionResets = (result     ) => {
        if (result && result.status === "accepted" && Array.isArray(result.clearedSessionKeys)) {

          setTimeout(() => {
            for (const sessionKey of result.clearedSessionKeys) {
              clearGlassesUiSurfacesOnly(sessionKey, "liveui_grant_revoked");
            }
          }, 0);
        }
        return result;
      };
      const result      = publicApi.applyLiveuiGrantIntent({ action, host, baseDigest });
      return result && typeof result.then === "function"
        ? result.then(scheduleSessionResets)
        : scheduleSessionResets(result);
    },

    onGetLiveuiStatus() {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller || typeof controller.getLiveuiStatus !== "function") return null;
      return controller.getLiveuiStatus();
    },

    onLiveuiVideoRoute({ clientId, action }     ) {
      const route = liveUiVideoRoute();
      const remote = ctx.server && typeof ctx.server.getClientRemote === "function" ? ctx.server.getClientRemote(clientId) : null;
      if (action === "enable") return route.enable(remote);
      if (action === "disable") return route.disable(remote);
      return route.get(remote);
    },

    onOrganizeLiveuiLibrary(params     ) {
      const controller = resolveLiveuiGlassesLibraryController();
      if (!controller) {
        return {
          action: params && typeof params.action === "string" ? params.action : "",
          status: "rejected",
          code: "item_unavailable",
        };
      }
      return controller.organizeLibrary(params);
    },
  };
}

module.exports = { createRelayLiveuiHandlers };
