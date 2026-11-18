const { cardStarterById } = require("../tools/card-starters.cjs");
const { supportsTaskPush } = require("./hermes-task-push.cjs");
const { TASK_SHEET_RESULT_FRAME, TASK_SHEET_VERSION, taskSheetResult } = require("./hermes-task-sheet.cjs");
const { TASK_TEST_CAPABILITY, TASK_TEST_RESULT_FRAME } = require("../tools/glasses-ui-task-test.cjs");

const TASK_USES_ANSWERS = new Set(["uses_allow", "uses_keep_off"]);

function createRelayTaskHandlers(ctx                          ) {
  const {
    opts,
    taskCardCreate,
    taskPresentations,
    relayBackendKind,
    seedTaskFromTest,
    openClawTaskSchedulesOn,
    openClawTaskRows,
    programCardSaves,
    pushProgramCardBindings,
    linkCreatedTask,
    openClawTaskSheetAgentId,
    cardPartInputsFor,
    openClawTaskPush,
    logger,
    ringTaskRows,
    taskCardLookUndo,
    savedTaskForCard,
    taskResultProposals,
    agentDrafts,
    taskFromWords,
  } = ctx;

  function taskPushClient(clientId     ) {
    if (!ctx.server || typeof ctx.server.getReadinessSnapshot !== "function") return null;
    const entry = (ctx.server.getReadinessSnapshot().clients || []).find((c     ) => c && c.clientId === clientId);
    return supportsTaskPush(entry) ? entry : null;
  }

  return {

    onTaskPushAck(ack     ) {
      if (typeof opts.onTaskPushAck === "function") opts.onTaskPushAck(ack);
      else if (openClawTaskSchedulesOn()) openClawTaskPush.ack(ack);
    },

    onGetTaskRows(clientId     ) {
      const read = typeof opts.onGetTaskRows === "function" ? opts.onGetTaskRows
        : openClawTaskSchedulesOn() ? () => openClawTaskRows.read() : null;
      return read && taskPushClient(clientId) ? read(clientId) : null;
    },

    onSetTaskLook(clientId     , choice     ) {
      const set = typeof opts.onSetTaskLook === "function" ? opts.onSetTaskLook
        : openClawTaskSchedulesOn() ? (c     ) => openClawTaskRows.useLook(c) : null;
      return set && taskPushClient(clientId) ? set(choice, clientId) : null;
    },

    onActTaskReminder(clientId     , choice     ) {
      const act = typeof opts.onActTaskReminder === "function" ? opts.onActTaskReminder
        : openClawTaskSchedulesOn() ? (c     ) => openClawTaskRows.actOnReminder(c) : null;
      return act && taskPushClient(clientId) ? act(choice, clientId) : null;
    },

    onTaskSheet(clientId     , request     ) {
      if (typeof opts.onTaskSheet !== "function" || !taskPushClient(clientId)) return null;

      const testId = request.op === "save" && typeof request.input?.testId === "string" ? request.input.testId : null;

      if (request.op === "save" && request.input?.starterCard) {
        if (!taskCardCreate || relayBackendKind !== "hermes") return { status: "rejected", code: "starter_card_unavailable" };
        return seedTaskFromTest(testId, taskCardCreate.saveStarter(clientId, request.input,
          (input     , context     ) => opts.onTaskSheet({ ...request, input, context }, clientId)).then((result     ) => {
          if (result?.status !== "saved") return result;
          pushProgramCardBindings();
          logger.info(`[program-card] starter card saved task=${result.taskId} card=${result.card?.appId}`);
          const source = result.card ? programCardSaves.source({ appId: result.card.appId }) : null;
          return source?.status === "accepted" ? { ...result, card: { ...result.card, sourceHash: source.sourceHash } } : result;
        }));
      }

      if (request.op === "save" && request.input?.card) {
        if (!taskCardCreate) return { status: "rejected", code: "presentation_unavailable" };
        return seedTaskFromTest(testId, taskCardCreate.save(clientId, request.input,
          (input     , context     ) => opts.onTaskSheet({ ...request, input, context }, clientId)).then((result     ) => {
          if (result?.status !== "saved") return result;
          pushProgramCardBindings();

          const source = result.card ? programCardSaves.source({ appId: result.card.appId }) : null;
          return source?.status === "accepted" ? { ...result, card: { ...result.card, sourceHash: source.sourceHash } } : result;
        }));
      }
      if (request.op === "save" && request.input?.presentation) {
        return seedTaskFromTest(testId, taskPresentations ? taskPresentations.save(clientId, request.input,
          (input     , context     ) => opts.onTaskSheet({ ...request, input, context }, clientId))
          : { status: "rejected", code: "presentation_unavailable" });
      }

      const cardPart = request.op === "save" ? request.input?.cardPart : null;
      if (cardPart) {
        const { cardPart: _part, ...input } = request.input;
        request = { ...request, input };
      }
      if (request.op === "save" && relayBackendKind !== "hermes" && !request.context?.agentId) {
        return seedTaskFromTest(testId, linkCreatedTask(clientId, testId, cardPart, openClawTaskSheetAgentId().then((agentId        ) =>
          opts.onTaskSheet({ ...request, context: { ...(request.context || {}), agentId } }, clientId))));
      }
      const outcome = seedTaskFromTest(testId, linkCreatedTask(clientId, testId, cardPart, opts.onTaskSheet(request, clientId)));

      if (request.op !== "act" || !TASK_USES_ANSWERS.has(request.action)) return outcome;
      return Promise.resolve(outcome).then((result     ) => {
        if (result?.act?.status === "done") ringTaskRows();
        return result;
      });
    },

    onTaskTest(clientId     , request     ) {
      const entry = taskPushClient(clientId);
      if (!entry || !entry.clientCapabilities.includes(TASK_TEST_CAPABILITY)) return null;
      if (request.op === "test_drop") return ctx.liveuiTaskTests.drop(request.testId) ? {} : null;
      if (request.op === "card_drop") {
        if (taskCardCreate) taskCardCreate.drop(request.handle).catch(() => {});
        return {};
      }
      if (request.op === "test_stop") return ctx.liveuiTaskTests.stop(request.requestId, request.testId);
      if (request.op === "test_act") return ctx.liveuiTaskTests.act(request.requestId, request.testId, request.action, request.useKey);

      if (request.op === "test_starter_report") {
        return ctx.liveuiTaskTests.starterReport(clientId, request.requestId, request.testId, request.checkId, request.report);
      }

      if (request.op === "card_save") {
        const answer = (outcome     ) => ({ type: TASK_SHEET_RESULT_FRAME, v: TASK_SHEET_VERSION,
          ...taskSheetResult("card", request.requestId, { taskId: request.taskId, ...(outcome || {}) }) });
        if (!taskCardCreate) return answer({ status: "rejected", code: "presentation_unavailable" });

        const saving = request.starterCard
          ? relayBackendKind === "hermes" ? taskCardCreate.attachStarter(clientId, request)
            : Promise.resolve({ status: "rejected", code: "starter_card_unavailable" })
          : request.addTo ? taskCardCreate.add(clientId, request) : taskCardCreate.attach(clientId, request);
        return saving.then((result     ) => {
          if (result?.status !== "saved" || !result.card) return answer(result);

          const source = programCardSaves.source({ appId: result.card.appId });
          return answer(source?.status === "accepted" ? { ...result, card: { ...result.card, sourceHash: source.sourceHash } } : result);
        });
      }

      if (request.op === "card_undo") {
        return taskCardLookUndo.undo(clientId, request).then((result     ) => ({ type: TASK_SHEET_RESULT_FRAME,
          v: TASK_SHEET_VERSION, ...taskSheetResult("card_undo", request.requestId, { taskId: request.taskId, ...(result || {}) }) }));
      }
      if (request.op !== "test_run") return null;

      const runTest = (input     , context     , saved      = null) => {
        if (relayBackendKind === "hermes") return ctx.liveuiTaskTests.run(clientId, request.requestId, request.testId, input, context);
        const own = saved?.version?.executor?.host === "openclaw" ? saved.version.executor.agentId : null;
        const agent                  = typeof own === "string" && own ? Promise.resolve(own) : openClawTaskSheetAgentId();
        return agent.then((agentId        ) => ctx.liveuiTaskTests.run(clientId, request.requestId, request.testId, input, { ...context, agentId }));
      };

      const starterCard = request.starterCard ? cardStarterById(request.starterCard) : null;

      const starter = starterCard ? { starterCard, ...(request.starterLocale ? { starterLocale: request.starterLocale } : {}) } : {};
      if (request.starterCard && (!starterCard || relayBackendKind !== "hermes")) return { type: TASK_TEST_RESULT_FRAME, v: 1,
        requestId: request.requestId, testId: request.testId, pass: 0, passesLeft: 0, status: "rejected",
        code: "starter_card_unavailable", uses: { held: true, entries: [], needs: [], keptOff: [] } };

      if (request.taskId) {
        const saved = savedTaskForCard(request.taskId);
        if (!saved) return { type: TASK_TEST_RESULT_FRAME, v: 1, requestId: request.requestId, testId: request.testId, pass: 0,
          passesLeft: 0, status: "rejected", code: "task_not_found", uses: { held: true, entries: [], needs: [], keptOff: [] } };
        const { look } = saved.plan;

        const input = { kind: saved.plan.kind, when: null, name: saved.name, request: saved.version.request,
          ...(look && look.kind !== "template" ? { look } : {}), ...request.input };

        const pinned = request.cardPart ? cardPartInputsFor(clientId, request.cardPart) : null;
        if (request.cardPart && !pinned) return { type: TASK_TEST_RESULT_FRAME, v: 1, requestId: request.requestId, testId: request.testId,
          pass: 0, passesLeft: 0, status: "rejected", code: "task_slot_undeclared", uses: { held: true, entries: [], needs: [], keptOff: [] } };
        return runTest({ ...input, ...(pinned ? { openCard: true } : {}) },
          { savedTaskId: request.taskId, ...(pinned ? { pinned } : {}), ...starter }, saved);
      }

      if (request.cardPart) {
        const pinned = cardPartInputsFor(clientId, request.cardPart);
        if (!pinned) return { type: TASK_TEST_RESULT_FRAME, v: 1, requestId: request.requestId, testId: request.testId,
          pass: 0, passesLeft: 0, status: "rejected", code: "task_slot_undeclared", uses: { held: true, entries: [], needs: [], keptOff: [] } };
        return runTest(request.input, { pinned });
      }
      return runTest(request.input, starter);
    },

    onTaskProposal(clientId     , request     ) {
      if (request.revision) return { ...(taskPresentations?.revision(clientId, request.taskId) || { status: "unavailable" }), requestId: request.requestId };
      if (request.applyRevision) return taskPresentations
        ? taskPresentations.applyRevision(clientId, request).then((result     ) => ({ ...result, requestId: request.requestId }))
        : { requestId: request.requestId, status: "unavailable" };
      if (request.cancel) taskPresentations?.cancel(clientId, request.requestId);
      if (request.preview) return taskPresentations
        ? taskPresentations.preview(clientId, request).then((result     ) => ({ ...result, requestId: request.requestId }))
        : { requestId: request.requestId, status: "unavailable" };
      return taskResultProposals.request(clientId, request);
    },

    onAgentDraft(clientId     , request     ) {
      return agentDrafts.request(clientId, request);
    },

    onTaskWords(clientId     , request     ) {
      return taskFromWords.request(clientId, request);
    },
  };
}

module.exports = { createRelayTaskHandlers };
