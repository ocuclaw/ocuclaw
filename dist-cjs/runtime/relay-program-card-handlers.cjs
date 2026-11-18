const { admitProgramCardPictures } = require("../domain/program-card-pictures.cjs");
const { formatProgramCardRefreshResult } = require("../tools/glasses-ui-program-card-feed.cjs");
const { TASK_AGENT_REFRESH_CAP_REASON } = require("../tools/glasses-ui-task-open-update.cjs");
const { cardHasParts } = require("../tools/glasses-ui-card-part-runs.cjs");
const { TASK_CHECK_AGAIN_NOT_ALLOWED, validCheckAgainTaskId } = require("../tools/glasses-ui-task-check-again.cjs");
const { PROGRAM_CARD_AGENT_REFRESH_NOT_ALLOWED } = require("../tools/glasses-ui-program-card-agent-refresh.cjs");
const { TASK_SLOT_FIRST, bindingSlot, validTaskSlotName } = require("../tools/glasses-ui-task-slots.cjs");

function createRelayProgramCardHandlers(ctx                                 ) {
  const {
    logger,
    taskPresentationClientOwns,
    pushProgramCardBindings,
    resolveLiveuiGlassesLibraryController,
    cardDrafts,
    programCardAgentRefresh,
    withCheckAgainAsk,
    taskCheckAgain,
    taskFixSave,
    dispatchProgramCardFeeds,
    emitDebug,
    programCardJev,
    programCardMcp,
    programCardSetupRequests,
    programCardModel,
    programCardArt,
    programCardLocation,
    dispatchLocationResponse,
    dispatchProgramCardResponse,
    dispatchProgramCardLookProgress,
    dispatchProgramCardContext,
    programCardBindingsSnapshot,
    checkAgainAsks,
    clientHasTaskSlots,
    privateCardAccess,
    programCardSaves,
    newTaskCardParts,
    startTaskFix,
    taskFixThrownAway,
    taskFixUndo,
    taskCardLookUndo,
  } = ctx;

  return {
    onProgramCardFeeds(frame     ) {
      dispatchProgramCardFeeds(frame);
    },

    onProgramCardPictures(clientId     , msg     ) {
      const admitted = admitProgramCardPictures(msg);
      if (!admitted.ok || !ctx.upstreamRuntime || typeof ctx.upstreamRuntime.openProgramCardPictures !== "function") {
        emitDebug("glasses.lifecycle", "program_card_pictures_ignored", "debug", {}, () => ({
          reason: admitted.ok ? "no_runtime" : admitted.reason,
        }));
        return;
      }
      if (admitted.op === "close") {
        ctx.upstreamRuntime.closeProgramCardPictures(clientId, admitted.sub);
        return;
      }
      const clientSession = ctx.server && typeof (ctx.server       ).getClientSessionKey === "function"
        ? (ctx.server       ).getClientSessionKey(clientId)
        : null;
      ctx.upstreamRuntime.openProgramCardPictures(clientId, clientSession, admitted);
    },

    onProgramCardJev(frame     ) {
      programCardJev.handle(frame);
    },

    onProgramCardMcp(frame     ) {
      programCardMcp.handle(frame);

      if (frame && frame.op === "server" && frame.allow === true) programCardSetupRequests.noteOn(`server:${frame.server}`);
    },

    onProgramCardModel(frame     , clientId        ) {
      void programCardModel.handle(frame, clientId);
    },

    onProgramCardArt(frame     , clientId        ) {
      void programCardArt.handle(frame, clientId);
    },

    onProgramCardLocation(clientId        , frame     ) {
      programCardLocation.handle(clientId, frame);
    },

    onLocationResponse(frame     ) {
      dispatchLocationResponse(frame);
    },

    onProgramCardResponse(frame     ) {
      dispatchProgramCardResponse(frame);
    },

    onProgramCardLookProgress(frame     ) {
      dispatchProgramCardLookProgress(frame);
    },

    onProgramCardContext(frame     ) {
      dispatchProgramCardContext(frame);
    },

    onProgramCardRequest({ clientId, type, msg, ownerWrite }     ) {
      if (type === "ocuclaw.program_card.drafts") {
        const sessionKey = ctx.server.getClientSessionKey(clientId);
        const operation = msg.action === "checkpoint"
          ? cardDrafts?.checkpoint(sessionKey, clientId, msg)
          : msg.action === "capture_saved" ? cardDrafts?.capture(sessionKey, clientId, msg)
          : cardDrafts?.run(sessionKey, msg, clientId);
        return Promise.resolve(operation || { ok: false, error: "draft_unavailable" }).then(result => ({
          unicast: JSON.stringify({ type: "ocuclaw.program_card.drafts.result", requestId: msg.requestId, action: msg.action, ...result }),
        }));
      }
      if (!ctx.programCardFeed) return null;
      const store = ctx.programCardFeed.store;
      const snapshot = () => programCardBindingsSnapshot(clientId);
      if (type === "ocuclaw.program.bindings.get") return { unicast: snapshot() };
      if (type === "ocuclaw.program.refresh") {
        const cardId = typeof msg.cardId === "string" ? msg.cardId : "";

        const slot = validTaskSlotName(msg.slot) ? msg.slot : undefined;
        const bound = store.forCard(cardId);
        const target = slot ? bound.find((entry     ) => bindingSlot(entry) === slot) : bound[0];

        if (msg.by === "agent" && !programCardAgentRefresh.allowed(`app:${cardId}`)) {
          return { unicast: formatProgramCardRefreshResult({ cardId, taskId: target?.taskId || null, ...(slot ? { slot } : {}), status: "rejected",
            code: "agent_refresh_not_allowed", reason: PROGRAM_CARD_AGENT_REFRESH_NOT_ALLOWED }) };
        }

        if (cardHasParts(store, cardId) && ctx.cardPartRuns) {
          return ctx.cardPartRuns.refresh({ clientId, cardId, ...(slot ? { slot } : {}), by: msg.by === "agent" ? "agent" : "wearer" })
            .then((result     ) => ({ unicast: formatProgramCardRefreshResult(withCheckAgainAsk(cardId, result.code === "agent_refresh_cap"
              ? { ...result, reason: TASK_AGENT_REFRESH_CAP_REASON } : result)) }));
        }

        if (msg.by !== "agent" && target && checkAgainAsks(clientId, target)) {
          return { unicast: formatProgramCardRefreshResult(withCheckAgainAsk(cardId, { cardId, taskId: target.taskId,
            ...(target.schemaVersion === 2 ? { slot: bindingSlot(target) } : {}), status: "rejected", code: TASK_CHECK_AGAIN_NOT_ALLOWED })) };
        }

        if (msg.by === "agent" && ctx.taskOpenUpdate) {
          const binding = target;
          if (binding && (binding.schemaVersion !== 2 || taskPresentationClientOwns(clientId, binding)) &&
              !ctx.taskOpenUpdate.takeAgentRefresh(binding).ok) {
            return { unicast: formatProgramCardRefreshResult({ cardId, taskId: binding.taskId, status: "rejected",
              code: "agent_refresh_cap", reason: TASK_AGENT_REFRESH_CAP_REASON }) };
          }
        }

        if (msg.by === "agent") ctx.taskRunsWeek?.agentRefreshAsked(target?.taskId);
        return ctx.programCardFeed.refresh({ clientId, cardId, ...(slot ? { slot } : {}), by: msg.by === "agent" ? "agent" : "card" })
          .then((result     ) => ({ unicast: formatProgramCardRefreshResult(result) }));
      }

      if (type === "ocuclaw.program.opened") {
        const cardId = typeof msg.cardId === "string" ? msg.cardId : "";
        const owns = (binding     ) => binding.schemaVersion !== 2 || taskPresentationClientOwns(clientId, binding) &&
          (bindingSlot(binding) === TASK_SLOT_FIRST || clientHasTaskSlots(clientId));

        if (!ctx.taskOpenUpdate || !store.forCard(cardId).some(owns)) return null;
        return ctx.taskOpenUpdate.opened({ clientId, cardId, owns }).then((frame     ) => {
          const frames = (Array.isArray(frame) ? frame : [frame]).filter(Boolean).map((entry     ) => JSON.stringify(entry));
          return frames.length ? { unicast: frames.length === 1 ? frames[0] : frames } : null;
        });
      }

      if (type === "ocuclaw.program.closed") {
        const cardId = typeof msg.cardId === "string" ? msg.cardId : undefined;
        ctx.cardPartRuns?.closed({ clientId, cardId });
        return null;
      }
      if (!ownerWrite) return { unicast: snapshot() };

      if (type === "ocuclaw.program.agent_refresh") {
        const cardId = typeof msg.cardId === "string" ? msg.cardId : "";
        if (!cardId || typeof msg.allow !== "boolean" || !privateCardAccess(clientId, cardId) ||
            programCardSaves.source({ appId: cardId }).status !== "accepted") return { unicast: snapshot() };
        const set = programCardAgentRefresh.set(cardId, msg.allow);
        if (set.status !== "accepted") logger.warn(`[program-card] agent refresh refused card=${cardId} code=${set.code}`);
        return { unicast: snapshot() };
      }

      if (type === "ocuclaw.program.check_again") {
        const cardId = typeof msg.cardId === "string" ? msg.cardId : "";
        if (!cardId || typeof msg.allow !== "boolean") return { unicast: snapshot() };
        const mine = store.forCard(cardId).filter((binding     ) => binding.schemaVersion !== 2 || taskPresentationClientOwns(clientId, binding));
        const named = Array.isArray(msg.taskIds) ? msg.taskIds.filter(validCheckAgainTaskId) : null;
        const taskIds = mine.map((binding     ) => binding.taskId).filter((id        ) => !named || named.includes(id));
        if (!taskIds.length) return { unicast: snapshot() };
        const set      = msg.allow ? taskCheckAgain.allow(taskIds, "glasses") : taskCheckAgain.remove(taskIds);
        if (set.status !== "accepted") logger.warn(`[program-card] check again ${msg.allow ? "ok" : "remove"} refused card=${cardId} code=${set.code}`);
        else logger.info(`[program-card] check again ${msg.allow ? "ok" : "removed"} card=${cardId} tasks=${(set.taskIds || []).join(",") || "-"}`);
        return { unicast: snapshot() };
      }
      const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
      const requestId = typeof msg.requestId === "string" ? msg.requestId.slice(0, 128) : "";

      if (type === "ocuclaw.program.binding.parts") {

        const answer = !ctx.cardPartLink ? { status: "rejected", code: "presentation_unavailable" }
          : !taskId && typeof msg.testId === "string" ? newTaskCardParts(clientId, msg.testId)
          : ctx.cardPartLink.parts({ clientId, taskId, testId: msg.testId });
        return { unicast: JSON.stringify({ type: "ocuclaw.program.binding.parts.result", requestId, taskId, ...answer }) };
      }

      if (type === "ocuclaw.program.binding.link") {
        const linked      = ctx.cardPartLink ? ctx.cardPartLink.link({ clientId, taskId, cardId: msg.cardId, slot: msg.slot,
          replace: msg.replace === true, testId: msg.testId }) : { status: "rejected", code: "presentation_unavailable" };
        const { binding: _binding, ...answer } = linked || {};
        if (linked?.status === "linked") {
          logger.info(`[program-card] linked task=${taskId} card=${linked.cardId} slot=${linked.slot}` +
            `${linked.replaced ? ` replaced=${linked.replaced}` : ""}${linked.movedFrom ? ` from=${linked.movedFrom}` : ""}`);
          const controller = resolveLiveuiGlassesLibraryController();
          if (controller && typeof controller.reconcileTaskSchedule === "function") {
            for (const id of [taskId, linked.replaced].filter(Boolean)) Promise.resolve(controller.reconcileTaskSchedule(id)).catch(() => {});
          }
          pushProgramCardBindings();
        } else logger.warn(`[program-card] link refused task=${taskId} code=${linked?.code}`);
        return { unicast: JSON.stringify({ type: "ocuclaw.program.binding.link.result", requestId, taskId, ...answer }) };
      }

      if (type === "ocuclaw.program.binding.fix_start") {
        const started      = startTaskFix(clientId, taskId, msg.handle);
        if (started.status !== "accepted") logger.warn(`[program-card] fix start refused task=${taskId} code=${started.code}`);

        else pushProgramCardBindings();
        return { unicast: JSON.stringify({ type: "ocuclaw.program.binding.fix_start.result", requestId, taskId, ...started }) };
      }

      if (type === "ocuclaw.program.binding.fix_save") {
        const reply = (answer     ) => ({ unicast: JSON.stringify({ type: "ocuclaw.program.binding.fix_save.result", requestId, taskId,
          handle: typeof msg.handle === "string" ? msg.handle : "", ...answer }) });
        if (!taskFixSave) return reply({ status: "rejected", code: "presentation_unavailable" });
        return taskFixSave.save(clientId, taskId, msg.handle).then((saved     ) => {
          if (saved.status !== "saved") logger.warn(`[program-card] fix save refused task=${taskId} code=${saved.code}`);
          if (saved.code === "card_changed" || saved.code === "task_changed") taskFixThrownAway(taskId, msg.handle);
          return reply(saved);
        }, (err     ) => {
          logger.warn(`[program-card] fix save failed task=${taskId}: ${err?.message || err}`);
          return reply({ status: "rejected", code: "card_save_failed" });
        });
      }

      if (type === "ocuclaw.program.binding.fix_undo") {
        const reply = (answer     ) => ({ unicast: JSON.stringify({ type: "ocuclaw.program.binding.fix_undo.result", requestId, taskId, ...answer }) });
        return taskFixUndo.undo(clientId, taskId).then((undone     ) => {
          if (undone.status !== "undone") {
            logger.warn(`[program-card] fix undo refused task=${taskId} code=${undone.code}`);
            pushProgramCardBindings();
          }
          return reply(undone);
        }, (err     ) => {
          logger.warn(`[program-card] fix undo failed task=${taskId}: ${err?.message || err}`);
          return reply({ status: "rejected", code: "card_save_failed" });
        });
      }

      if (type === "ocuclaw.program.binding.open_update") {
        const existing = store.read(taskId);
        if (!existing || !ctx.taskOpenUpdate || existing.schemaVersion === 2 && !taskPresentationClientOwns(clientId, existing))
          return { unicast: snapshot() };
        const allowed = ctx.taskOpenUpdate.gate(taskId).ok;
        const set = ctx.taskOpenUpdate.set(taskId, { on: msg.on === true && allowed,
          ...(msg.staleMs !== undefined ? { staleMs: msg.staleMs } : {}),
          ...(msg.agentCap !== undefined ? { agentCap: msg.agentCap } : {}) });
        if (set.status !== "accepted") logger.warn(`[program-card] open update refused task=${taskId} code=${set.code}`);
        pushProgramCardBindings();
        return { unicast: snapshot() };
      }

      const existing = store.read(taskId);

      if (type === "ocuclaw.program.binding.relink") {
        if (existing?.schemaVersion !== 2 || !taskPresentationClientOwns(clientId, existing)) return { unicast: snapshot() };
        const relinked = ctx.programCardFeed.relink(taskId);
        if (relinked.status !== "accepted") {
          logger.warn(`[program-card] relink refused task=${taskId} code=${relinked.code}`);
          return { unicast: snapshot() };
        }
        logger.info(`[program-card] relinked task=${taskId} card=${relinked.binding.cardId} version=${relinked.binding.taskVersionId}`);

        const controller = resolveLiveuiGlassesLibraryController();
        if (controller && typeof controller.reconcileTaskSchedule === "function") {
          Promise.resolve(controller.reconcileTaskSchedule(taskId)).catch(() => {});
        }
        pushProgramCardBindings();
        return { unicast: snapshot() };
      }

      if (type === "ocuclaw.program.binding.fix_not_now") {
        if (existing?.schemaVersion !== 2 || !taskPresentationClientOwns(clientId, existing)) return { unicast: snapshot() };
        const later      = store.fixNotNow(taskId);
        if (later.status !== "accepted") {
          logger.warn(`[program-card] fix not now refused task=${taskId} code=${later.code}`);
          return { unicast: snapshot() };
        }
        logger.info(`[program-card] fix not now task=${taskId} card=${existing.cardId}`);
        pushProgramCardBindings();
        return { unicast: snapshot() };
      }

      if (type === "ocuclaw.program.binding.fix_close") {
        if (existing?.schemaVersion !== 2 || !taskPresentationClientOwns(clientId, existing)) return { unicast: snapshot() };
        const closed      = store.fixClose(taskId);
        if (closed.status !== "accepted") {
          logger.warn(`[program-card] fix close refused task=${taskId} code=${closed.code}`);
          return { unicast: snapshot() };
        }
        logger.info(`[program-card] fix box closed task=${taskId} card=${existing.cardId}`);
        pushProgramCardBindings();
        return { unicast: snapshot() };
      }
      if (existing?.schemaVersion === 2 && (type === "ocuclaw.program.binding.set" || !taskPresentationClientOwns(clientId, existing)))
        return { unicast: snapshot() };
      if (type === "ocuclaw.program.binding.set") {
        const bound = store.bind({
          taskId,
          cardId: msg.cardId,
          cardName: msg.cardName,
          inputs: msg.inputs,
        });
        if (bound.status !== "accepted") {
          logger.warn(`[program-card] binding refused task=${taskId} code=${bound.code}`);
        } else {
          logger.info(`[program-card] bound task=${taskId} card=${bound.binding.cardId}`);

          const controller = resolveLiveuiGlassesLibraryController();
          if (controller && typeof controller.reconcileTaskSchedule === "function") {
            Promise.resolve(controller.reconcileTaskSchedule(taskId)).catch(() => {});
          }
        }
      } else {
        const cleared      = store.clear(taskId);
        logger.info(`[program-card] binding cleared task=${taskId}`);

        const controller = cleared?.cleared === true ? resolveLiveuiGlassesLibraryController() : null;
        if (cleared?.cleared === true && existing) {
          taskCardLookUndo.restore(taskId, existing.cardId).catch(() => false).then(() => {
            if (controller && typeof controller.reconcileTaskSchedule === "function") return controller.reconcileTaskSchedule(taskId);
          }).catch(() => {});
        } else if (controller && typeof controller.reconcileTaskSchedule === "function") {
          Promise.resolve(controller.reconcileTaskSchedule(taskId)).catch(() => {});
        }
      }
      pushProgramCardBindings();
      return { unicast: snapshot() };
    },
  };
}

module.exports = { createRelayProgramCardHandlers };
