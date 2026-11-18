const { admitLiveUiPictureWant, admitLiveUiVideoWant } = require("../domain/liveui-picture-want.cjs");
const { PROGRAM_CARD_PICTURE_SURFACE_PREFIX } = require("../domain/program-card-pictures.cjs");
const { relaySessionKeyFor } = require("./openclaw-session-key.cjs");

function createRelayGlassesUiHandlers(ctx                               ) {
  const {
    emitDebug,
    setupWelcome,
    resolveLiveuiGlassesLibraryController,
    glassesUiResultChannel,
    liveUiV2Sender,
    logger,
    dispatchGlassesUiResult,
    draftApprovalClients,
    draftBindingCurrent,
    dispatchGlassesUiNavEvent,
    glassesUiRenderReceiptChannel,
    dispatchGlassesUiRenderReceipt,
    appSessionKeysMatch,
  } = ctx;

  return {
    onGlassesUiResult(frame     ) {
      if (setupWelcome && !setupWelcome.admitOutcome(frame)) return;
      const liveuiController = resolveLiveuiGlassesLibraryController();
      const taskSessionKey =
        liveuiController && typeof liveuiController.sessionForSurface === "function"
          ? liveuiController.sessionForSurface(frame && frame.surfaceId)
          : null;
      emitDebug(
        "glasses.lifecycle",
        "surface_outcome",
        "debug",
        {},
        () => ({
          surfaceId: frame && frame.surfaceId,

          outcome:
            frame && frame.outcome && typeof frame.outcome === "object" && frame.outcome.report !== undefined
              ? (({ report, ...rest }     ) => ({
                  ...rest,
                  reportRev: report && Number.isSafeInteger(report.rev) ? report.rev : null,
                }))(frame.outcome)
              : frame && frame.outcome,

          handlerCount: glassesUiResultChannel.size,
        }),
      );
      if (glassesUiResultChannel.size === 0) {
        logger.warn(
          `[relay] glasses_ui_result dropped: no subscribed handlers (surfaceId=${frame && frame.surfaceId})`,
        );
      }
      dispatchGlassesUiResult(frame);
      if (ctx.liveuiTaskRunController && taskSessionKey) {
        ctx.liveuiTaskRunController.observeSurfaceOutcome({
          sessionKey: taskSessionKey,
          outcome: frame && frame.outcome,
        });
      }
    },

    onDemandResponse(frame     ) {
      if (frame?.surfaceId?.startsWith("draft-launch-")) {
        const binding = draftApprovalClients.get(frame.surfaceId);
        if (!binding || binding.clientId !== frame.clientId || !draftBindingCurrent(binding)) return;
      }
      emitDebug(
        "glasses.lifecycle",
        "demand_response",
        "debug",
        {},
        () => ({
          surfaceId: frame && frame.surfaceId,
          result: frame && frame.result,
          selectedIndex: frame && frame.selectedIndex,
          selectedIndices: frame && frame.selectedIndices,
          ...(frame && frame.exit ? { exit: frame.exit } : {}),
        }),
      );
      ctx.demandRouter?.handleOutcome(frame);
    },

    onGlassesUiNavEvent(frame     ) {
      emitDebug(
        "glasses.lifecycle",
        "nav_event_recv",
        "debug",
        {},
        () => ({ surfaceId: frame && frame.surfaceId, depth: frame && frame.depth }),
      );
      dispatchGlassesUiNavEvent(frame);
    },

    onLiveUiStateReport(frame     ) {
      if (!ctx.upstreamRuntime || typeof ctx.upstreamRuntime.noteLiveUiV2StateReport !== "function") return;
      ctx.upstreamRuntime.noteLiveUiV2StateReport({
        report: frame && frame.report,
        clientId: frame && typeof frame.clientId === "string" ? frame.clientId : null,
        authoritative: frame && frame.authoritative === true,
        authorityReason: frame && typeof frame.authorityReason === "string" ? frame.authorityReason : null,
      });
    },

    onLiveUiPictureWant(clientId     , msg     ) {
      const v2 = liveUiV2Sender();
      const clientSession = ctx.server && typeof (ctx.server       ).getClientSessionKey === "function"
        ? (ctx.server       ).getClientSessionKey(clientId)
        : null;

      if (msg && typeof msg.surfaceId === "string" && msg.surfaceId.startsWith(PROGRAM_CARD_PICTURE_SURFACE_PREFIX)) {
        const cardRuntime = ctx.upstreamRuntime && typeof ctx.upstreamRuntime.handleProgramCardPictureWant === "function" ? ctx.upstreamRuntime : null;
        const cardVerdict = admitLiveUiPictureWant(
          msg,
          (surfaceId) => (cardRuntime ? cardRuntime.programCardPictureSessionOf(surfaceId, clientId) : null),
          clientSession || "main",

          () => true,
        );
        if (!cardVerdict.ok || !cardRuntime) {
          emitDebug("glasses.lifecycle", "program_card_picture_want_ignored", "debug", {}, () => (
            cardVerdict.ok ? { surfaceId: cardVerdict.want.surfaceId, skipped: "no_runtime" } : { surfaceId: cardVerdict.surfaceId, ids: cardVerdict.ids, skipped: cardVerdict.reason }
          ));
          return;
        }
        cardRuntime.handleProgramCardPictureWant(clientId, cardVerdict.want);
        return;
      }
      const verdict = admitLiveUiPictureWant(
        msg,
        (surfaceId) => (v2 ? v2.surfaceSessionOf(surfaceId) : null),
        clientSession,
        (surfaceSession, key) =>
          appSessionKeysMatch(surfaceSession, key) || appSessionKeysMatch(surfaceSession, relaySessionKeyFor(key) || key),
      );
      if (!verdict.ok || !ctx.upstreamRuntime) {
        emitDebug("glasses.lifecycle", "liveui_v2_picture_want_ignored", "debug", {}, () => (
          verdict.ok ? { surfaceId: verdict.want.surfaceId, skipped: "no_runtime" } : { surfaceId: verdict.surfaceId, ids: verdict.ids, skipped: verdict.reason }
        ));
        return;
      }
      ctx.upstreamRuntime.handleLiveUiPictureWant(clientId, verdict.sessionKey, verdict.want);
    },

    onLiveUiVideoWant(clientId     , msg     ) {
      const v2 = liveUiV2Sender();
      const clientSession = ctx.server && typeof (ctx.server       ).getClientSessionKey === "function"
        ? (ctx.server       ).getClientSessionKey(clientId)
        : null;
      const verdict = admitLiveUiVideoWant(
        msg,
        (surfaceId) => (v2 ? v2.surfaceSessionOf(surfaceId) : null),
        clientSession,
        (surfaceSession, key) =>
          appSessionKeysMatch(surfaceSession, key) || appSessionKeysMatch(surfaceSession, relaySessionKeyFor(key) || key),
      );
      if (!verdict.ok || !ctx.upstreamRuntime || typeof ctx.upstreamRuntime.handleLiveUiVideoWant !== "function") {
        emitDebug("glasses.lifecycle", "liveui_v2_video_want_ignored", "debug", {}, () => (
          verdict.ok ? { surfaceId: verdict.want.surfaceId, skipped: "no_runtime" } : { surfaceId: verdict.surfaceId, skipped: verdict.reason }
        ));
        return;
      }
      ctx.upstreamRuntime.handleLiveUiVideoWant(clientId, verdict.sessionKey, verdict.want);
    },

    onGlassesUiRenderReceipt(frame     ) {

      emitDebug(
        "glasses.lifecycle",
        "render_receipt_recv",
        "debug",
        {},
        () => ({
          surfaceId: frame && frame.surfaceId,
          seq: frame && frame.seq,
          handlerCount: glassesUiRenderReceiptChannel.size,
        }),
        {},
      );
      dispatchGlassesUiRenderReceipt(frame);

      Promise.resolve().then(() => {
        if (!ctx.liveuiTaskRunController) return;
        const liveuiController = resolveLiveuiGlassesLibraryController();
        if (!liveuiController) return;
        const surfaceId = frame && frame.surfaceId;
        const seq = frame && frame.seq;
        if (
          typeof liveuiController.hasClientReceipt !== "function" ||
          !liveuiController.hasClientReceipt(surfaceId, seq)
        ) return;
        const sessionKey =
          typeof liveuiController.sessionForSurface === "function"
            ? liveuiController.sessionForSurface(surfaceId)
            : null;
        if (sessionKey) {
          const first = ctx.liveuiTaskRunController.observeFirstRender({
            sessionKey,
            surfaceId,
            at: Date.now(),
          });
          if (!first) {
            ctx.liveuiTaskRunController.observeSurfaceRender({ sessionKey, surfaceId });
          }
          const delivery = typeof liveuiController.deliveryStateOf === "function"
            ? liveuiController.deliveryStateOf(surfaceId)
            : null;
          if (delivery && typeof delivery.rung === "string") {
            ctx.liveuiTaskRunController.observeSurfaceDelivery({
              sessionKey,
              surfaceId,
              delivery: delivery.rung,
            });
          }
        }
      });
    },
  };
}

module.exports = { createRelayGlassesUiHandlers };
