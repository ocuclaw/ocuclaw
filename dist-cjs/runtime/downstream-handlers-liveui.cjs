const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { formatError } = require("./downstream-codec-core.cjs");
const { formatLiveuiLibrary, formatLiveuiLibraryOpenResult, formatProgramCardSaveResult, formatProgramCardCheckpointResult, formatProgramCardOpen, formatProgramCardSource, formatProgramCardRevisions, formatProgramCardRevisionResult, formatProgramCardSlots, formatProgramCardSlotResult, formatProgramCardReview, formatProgramCardReviewApplyResult, formatLiveuiTasks, formatLiveuiTaskRuns, formatLiveuiTaskReviewAck, formatLiveuiTaskExecutors, formatLiveuiTaskExecutorAck, formatLiveuiTaskPreferredTemplateAck, formatLiveuiTaskContextAck, formatLiveuiPrefs, formatLiveuiPrefsAck, formatLiveuiGrantsSnapshot, formatLiveuiGrantsAck, formatLiveuiStatus, formatLiveuiVideoRouteState, formatLiveuiTaskSettingsAck, formatLiveuiLibraryOrganizeAck } = require("./downstream-codec-liveui.cjs");

function createLiveuiHandlers({
  logger,
  isPhoneClient,
  admitPhoneOnlyWrite,
  onGetLiveuiLibrary,
  onOpenLiveuiLibraryItem,
  onCancelLiveuiTaskLaunch,
  onGetLiveuiTasksForPhone,
  onGetLiveuiTaskRunsForPhone,
  onGetLiveuiTaskExecutors,
  onSetLiveuiTaskExecutor,
  onSetLiveuiTaskSettingValues,
  onSetLiveuiTaskPreferredTemplate,
  onReviewLiveuiTask,
  onSetLiveuiTaskContext,
  onGetLiveuiPrefs,
  onSetLiveuiPrefs,
  onGetLiveuiGrants,
  onSetLiveuiGrant,
  onGetLiveuiStatus,
  onOrganizeLiveuiLibrary,
  onLiveuiVideoRoute,
  onSaveProgramCard,
  onCheckpointProgramCard,
  onOpenProgramCard,
  onGetProgramCardSource,
  onGetProgramCardRevisions,
  onProgramCardRevision,
  onProgramCardReview,
  onProgramCardReviewApply,
  onProgramCardRevisionPicture,
  onGetProgramCardSlots,
  onProgramCardSlot,
}     ) {

  function handleLiveuiVideoRoute(clientId     , msg     ) {
    const action = msg && (msg.action === "enable" || msg.action === "disable") ? msg.action : "get";
    if (!admitPhoneOnlyWrite(clientId, `${APP_PROTOCOL.liveuiVideoRoute}:${action}`)) {
      return {
        unicast: formatError("Video route is phone-only", {
          code: "phone_only",
          op: APP_PROTOCOL.liveuiVideoRoute,
        }),
      };
    }
    if (!onLiveuiVideoRoute) {
      return { unicast: formatLiveuiVideoRouteState({ state: "no_tailscale_here" }) };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] LiveUI video route ${action} failed: ${err && err.message ? err.message : err}`);
      return { unicast: formatLiveuiVideoRouteState({ state: "no_tailscale_here", detail: "Could not read the host's Tailscale" }) };
    };
    return Promise.resolve()
      .then(() => onLiveuiVideoRoute({ clientId, action }))
      .then((snapshot     ) => ({ unicast: formatLiveuiVideoRouteState(snapshot || {}) }), failure)
      .catch(failure);
  }

  function handleGetLiveuiLibrary(clientId     ) {
    if (!onGetLiveuiLibrary) return { unicast: formatLiveuiLibrary([]) };
    return Promise.resolve(onGetLiveuiLibrary()).then(
      (items) => ({ unicast: formatLiveuiLibrary(items) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Library failed: ${err.message}`);
        return { unicast: formatLiveuiLibrary([]) };
      },
    );
  }

  function handleOpenProgramCard(clientId     , itemId     ) {
    const rejected = (code     ) => ({
      unicast: formatLiveuiLibraryOpenResult({ itemType: "app", itemId, status: "rejected", code }),
    });
    return Promise.resolve()
      .then(() => onOpenProgramCard({ clientId, appId: itemId }))
      .then(
        (result     ) => {
          if (!result || result.status !== "accepted" || !result.open) {
            return rejected(result && typeof result.code === "string" ? result.code : "app_not_found");
          }
          return {
            unicast: formatLiveuiLibraryOpenResult({ itemType: "app", itemId, status: "accepted" }),

            ...(result.deliveredPrivately === true ? {} : { broadcast: formatProgramCardOpen(result.open) }),
          };
        },
        (err     ) => {
          logger.error(`[downstream] open saved card failed: ${err && err.message ? err.message : err}`);
          return rejected("app_not_found");
        },
      );
  }

  function libraryBroadcast() {
    if (!onGetLiveuiLibrary) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => onGetLiveuiLibrary())
      .then(
        (items     ) => formatLiveuiLibrary(items),
        (err     ) => {
          logger.error(`[downstream] Library snapshot after a card save failed: ${err && err.message ? err.message : err}`);
          return null;
        },
      );
  }

  function revisionsSnapshot(appId     ) {
    if (!onGetProgramCardRevisions || typeof appId !== "string" || !appId) return Promise.resolve(null);
    return Promise.resolve()
      .then(() => onGetProgramCardRevisions({ appId }))
      .then(
        (result     ) => (result && result.status === "accepted" ? formatProgramCardRevisions(result) : null),
        (err     ) => {
          logger.error(`[downstream] card revisions after a change failed: ${err && err.message ? err.message : err}`);
          return null;
        },
      );
  }

  function changedBroadcast(...appIds       ) {
    return Promise.all([libraryBroadcast(), ...appIds.map(revisionsSnapshot)])
      .then((frames       ) => frames.filter(Boolean));
  }

  function handleGetProgramCardSource(clientId     , msg     ) {
    const requestId = typeof msg.requestId === "string" && msg.requestId.length <= 64 ? msg.requestId : "";
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const reply = (result     ) => ({ unicast: formatProgramCardSource({ ...(result || {}), requestId, appId }) });
    if (!isPhoneClient(clientId)) return reply({ code: "phone_only" });
    if (!requestId) return reply({ code: "request_invalid" });
    if (!onGetProgramCardSource) return reply({ code: "source_unavailable" });
    return Promise.resolve().then(() => onGetProgramCardSource({ clientId, appId }))
      .then(reply, () => reply({ code: "source_unavailable" }));
  }

  function handleGetProgramCardRevisions(clientId     , msg     ) {
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const rejected = (code     ) => ({ unicast: formatProgramCardRevisions({ appId, status: "rejected", code }) });
    if (!onGetProgramCardRevisions) return rejected("revisions_unavailable");
    return Promise.resolve()
      .then(() => onGetProgramCardRevisions({ clientId, appId }))
      .then(
        (result     ) => ({ unicast: formatProgramCardRevisions({ appId, ...(result || {}) }) }),
        (err     ) => {
          logger.error(`[downstream] card revisions failed: ${err && err.message ? err.message : err}`);
          return rejected("revisions_unavailable");
        },
      );
  }

  const PROGRAM_CARD_REVISION_ACTIONS = new Set(["restore", "delete", "fork", "rename", "frame_redraw", "frame_remove"]);

  function handleProgramCardRevision(clientId     , msg     ) {
    const requestId = typeof msg.requestId === "string" && msg.requestId.length <= 64 ? msg.requestId : "";
    const action = typeof msg.action === "string" ? msg.action : "";
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const rejected = (code     ) => ({
      unicast: formatProgramCardRevisionResult({ requestId, action, appId, number: msg.number, status: "rejected", code }),
    });
    if (!requestId) return rejected("request_invalid");
    if (!PROGRAM_CARD_REVISION_ACTIONS.has(action)) return rejected("action_invalid");
    if (!admitPhoneOnlyWrite(clientId, `${APP_PROTOCOL.programCardRevision}:${action}`)) return rejected("phone_only");
    if (!onProgramCardRevision) return rejected("revisions_unavailable");
    return Promise.resolve()
      .then(() => onProgramCardRevision({
        clientId,
        action,
        appId,
        ...(msg.number !== undefined ? { number: msg.number } : {}),
        ...(typeof msg.name === "string" ? { name: msg.name } : {}),
        ...(action === "frame_redraw" ? {
          requestId,
          ...(typeof msg.style === "string" ? { style: msg.style } : {}),

          ...(typeof msg.detail === "string" ? { detail: msg.detail } : {}),
          ...(msg.frameLayout && typeof msg.frameLayout === "object" && !Array.isArray(msg.frameLayout) ? { frameLayout: msg.frameLayout } : {}),
        } : {}),
      }))
      .then(
        (result     ) => {
          const outcome = result || {};
          const unicast = formatProgramCardRevisionResult({
            requestId,
            action,
            ...outcome,

            appId,
            ...(action === "fork" && outcome.status === "saved" ? { newAppId: outcome.appId } : {}),
          });
          if (!["restored", "deleted", "saved", "renamed"].includes(outcome.status)) return { unicast };
          const changed = action === "fork" ? [outcome.appId] : [appId];
          return changedBroadcast(...changed).then((broadcast) => ({
            unicast,
            ...(broadcast.length ? { broadcast } : {}),
          }));
        },
        (err     ) => {
          logger.error(`[downstream] card revision ${action} failed: ${err && err.message ? err.message : err}`);
          return rejected("revision_failed");
        },
      );
  }

  function handleGetProgramCardSlots(clientId     , msg     ) {
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const rejected = (code     ) => ({ unicast: formatProgramCardSlots({ appId, status: "rejected", code }) });
    if (!onGetProgramCardSlots) return rejected("slots_unavailable");
    return Promise.resolve()
      .then(() => onGetProgramCardSlots({ clientId, appId }))
      .then(
        (result     ) => ({ unicast: formatProgramCardSlots({ appId, ...(result || {}) }) }),
        (err     ) => {
          logger.error(`[downstream] card slots failed: ${err && err.message ? err.message : err}`);
          return rejected("slots_unavailable");
        },
      );
  }

  const PROGRAM_CARD_SLOT_ACTIONS = new Set(["save", "load", "delete"]);

  function handleProgramCardSlot(clientId     , msg     ) {
    const requestId = typeof msg.requestId === "string" && msg.requestId.length <= 64 ? msg.requestId : "";
    const action = typeof msg.action === "string" ? msg.action : "";
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const rejected = (code     ) => ({
      unicast: formatProgramCardSlotResult({ requestId, action, appId, slot: msg.slot, status: "rejected", code }),
    });
    if (!requestId) return rejected("request_invalid");
    if (!PROGRAM_CARD_SLOT_ACTIONS.has(action)) return rejected("action_invalid");
    if (!admitPhoneOnlyWrite(clientId, `${APP_PROTOCOL.programCardSlot}:${action}`)) return rejected("phone_only");
    if (!onProgramCardSlot) return rejected("slots_unavailable");
    return Promise.resolve()
      .then(() => onProgramCardSlot({
        clientId,
        action,
        appId,
        slot: msg.slot,
        ...(action === "save" ? {
          state: msg.state,
          revision: msg.revision,
          sourceHash: msg.sourceHash,
          ...(typeof msg.label === "string" ? { label: msg.label } : {}),
          replace: msg.replace === true,
        } : {}),
      }))
      .then(
        (result     ) => {
          const outcome = result || {};
          const unicast = formatProgramCardSlotResult({ requestId, action, ...outcome, appId });
          if (outcome.status !== "saved" && outcome.status !== "deleted") return { unicast };
          return Promise.resolve()
            .then(() => onGetProgramCardSlots ? onGetProgramCardSlots({ clientId, appId }) : null)
            .then(
              (rows     ) => rows && rows.status === "accepted" ? formatProgramCardSlots({ appId, ...rows }) : null,
              () => null,
            )
            .then((rows     ) => ({ unicast: rows ? [unicast, rows] : unicast }));
        },
        (err     ) => {
          logger.error(`[downstream] card slot ${action} failed: ${err && err.message ? err.message : err}`);
          return rejected("slot_failed");
        },
      );
  }

  const PROGRAM_CARD_REVIEW_OPS      = {
    [APP_PROTOCOL.programCardReviewGet]: "get",
    [APP_PROTOCOL.programCardReviewStart]: "start",
    [APP_PROTOCOL.programCardReviewCancel]: "cancel",
    [APP_PROTOCOL.programCardReviewDecide]: "decide",
    [APP_PROTOCOL.programCardReviewRetry]: "retry",
    [APP_PROTOCOL.programCardReviewRetryCancel]: "retry_cancel",
  };

  function handleProgramCardReview(clientId     , msg     ) {
    const op = PROGRAM_CARD_REVIEW_OPS[msg.type];
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const requestId = typeof msg.requestId === "string" && msg.requestId.length <= 64 ? msg.requestId : "";
    const answer = (view     , code      = null) => {
      const readable = { ...(view || {}) };

      const refused = code || readable.code;
      if (op !== "get" && refused) {
        const look = msg.look === undefined ? "" : msg.look === null ? " look=wait" : " look=report";
        logger.warn(`[downstream] card review ${op} rejected code=${String(refused).replace(/[^a-z0-9_]/gi, "").slice(0, 40)} app=${appId.slice(0, 64)}${look}`);
      }
      if (!isPhoneClient(clientId)) {
        for (const key of ["lookVersion", "source", "sourceDigest", "state", "asks", "revision"]) delete readable[key];
      }
      return { unicast: formatProgramCardReview({
        appId,
        ...readable,
        ...(requestId ? { requestId } : {}),
        ...(code ? { code } : {}),
      }) };
    };
    if (!onProgramCardReview) return answer({ available: false, review: null }, "review_unavailable");
    const ask = (request     ) => Promise.resolve().then(() => onProgramCardReview({ clientId, appId, ...request }));
    const failure = (err     ) => {
      logger.error(`[downstream] card review ${op} failed: ${err && err.message ? err.message : err}`);
      return answer({ available: false, review: null }, "review_failed");
    };
    if (op !== "get" && !admitPhoneOnlyWrite(clientId, `${APP_PROTOCOL.programCardReview}:${op}`)) {
      return ask({ op: "get" }).then((view     ) => answer(view, "phone_only"), failure);
    }
    if ((op === "retry" || op === "retry_cancel") && !requestId) return answer({}, "request_invalid");
    return ask({
      op,
      ...(op === "start" && typeof msg.source === "string" ? { source: msg.source } : {}),
      ...(op === "start" && typeof msg.speed === "string" ? { speed: msg.speed } : {}),
      ...(op === "start" && msg.look !== undefined ? { look: msg.look } : {}),
      ...(op === "start" && msg.asks !== undefined ? { asks: msg.asks } : {}),

      ...(op === "start" && typeof msg.reviewFocus === "string" ? { reviewFocus: msg.reviewFocus } : {}),

      ...(op === "start" && Array.isArray(msg.controls) ? { controls: msg.controls } : {}),
      ...(op === "cancel" ? {
        ...(typeof msg.reviewId === "string" ? { reviewId: msg.reviewId } : {}),
        ...(typeof msg.candidateId === "string" ? { candidateId: msg.candidateId } : {}),
      } : {}),
      ...(["decide", "retry", "retry_cancel"].includes(op)
        ? { reviewId: msg.reviewId, ideaId: msg.ideaId, decision: msg.decision, attemptId: msg.attemptId }
        : {}),
    }).then((view     ) => answer(view), failure);
  }

  function handleProgramCardReviewLookStep(clientId     , msg     ) {
    if (!onProgramCardReview || !admitPhoneOnlyWrite(clientId, APP_PROTOCOL.programCardReviewLookStep)) return null;
    return Promise.resolve()
      .then(() => onProgramCardReview({
        clientId,
        op: "look_step",
        appId: typeof msg.appId === "string" ? msg.appId : "",
        reviewId: typeof msg.reviewId === "string" ? msg.reviewId : "",
        step: msg.step,
        label: msg.label,
        png: msg.png,
      }))
      .then(() => null, (err     ) => {
        logger.error(`[downstream] card review look step failed: ${err && err.message ? err.message : err}`);
        return null;
      });
  }

  function handleProgramCardRevisionPicture(clientId     , msg     ) {
    if (!onProgramCardRevisionPicture || !admitPhoneOnlyWrite(clientId, APP_PROTOCOL.programCardRevisionPicture)) return null;
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    return Promise.resolve()
      .then(() => onProgramCardRevisionPicture({
        clientId,
        appId,
        number: msg.revision,
        png: msg.png,
      }))
      .then((result     ) => (result?.status === "kept" ? revisionsSnapshot(appId) : null))
      .then((revisions     ) => (revisions ? { broadcast: [revisions] } : null), (err     ) => {
        logger.error(`[downstream] card revision picture failed: ${err && err.message ? err.message : err}`);
        return null;
      });
  }

  function handleProgramCardReviewApply(clientId     , msg     ) {
    const requestId = typeof msg.requestId === "string" && msg.requestId.length <= 64 ? msg.requestId : "";
    const ids = {
      appId: typeof msg.appId === "string" ? msg.appId : "",
      reviewId: typeof msg.reviewId === "string" ? msg.reviewId : "",
      ideaId: typeof msg.ideaId === "string" ? msg.ideaId : "",
    };
    const answer = (result     ) => {

      if (result?.status === "rejected") {
        const code = String(result.code || "none").replace(/[^a-z0-9_]/gi, "").slice(0, 40);
        logger.warn(`[downstream] card review apply rejected code=${code} app=${ids.appId.slice(0, 64)} idea=${ids.ideaId.slice(0, 40)}${typeof msg.candidateId === "string" ? " save" : ""}`);
      }
      return { unicast: formatProgramCardReviewApplyResult({ requestId, ...ids, ...(result || {}) }) };
    };
    if (!requestId) return answer({ status: "rejected", code: "request_invalid" });
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.programCardReviewApply)) {
      return answer({ status: "rejected", code: "phone_only" });
    }
    if (!onProgramCardReviewApply) return answer({ status: "rejected", code: "review_unavailable" });
    const check = msg.check && typeof msg.check === "object" && !Array.isArray(msg.check)
      ? {
          ok: msg.check.ok === true,
          ...(typeof msg.check.error === "string" ? { error: msg.check.error } : {}),
          ...(msg.check.state !== undefined ? { state: msg.check.state } : {}),
          ...(msg.check.look !== undefined ? { look: msg.check.look } : {}),
        }
      : null;
    return Promise.resolve()
      .then(() => onProgramCardReviewApply({
        clientId,
        ...ids,
        ...(typeof msg.candidateId === "string" ? { candidateId: msg.candidateId } : {}),
        ...(check ? { check } : {}),
        ...(msg.force === true ? { force: true } : {}),
        ...(msg.canHold === true ? { canHold: true } : {}),
      }))
      .then(
        (result     ) => {
          if (!result || result.status !== "saved") return answer(result);
          return changedBroadcast(ids.appId).then((broadcast) => ({
            ...answer(result),
            ...(broadcast.length ? { broadcast } : {}),
          }));
        },
        (err     ) => {
          logger.error(`[downstream] card review apply failed: ${err && err.message ? err.message : err}`);
          return answer({ status: "rejected", code: "apply_failed" });
        },
      );
  }

  function handleSaveProgramCard(clientId     , msg     ) {
    const requestId = typeof msg.requestId === "string" && msg.requestId.length <= 64 ? msg.requestId : "";
    const name = typeof msg.name === "string" ? msg.name.trim() : "";
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const rejected = (code     ) => ({
      unicast: formatProgramCardSaveResult({ requestId, status: "rejected", appId, name, code }),
    });
    if (!requestId) return rejected("request_invalid");
    if (!onSaveProgramCard) return rejected("save_unavailable");
    return Promise.resolve()
      .then(() => onSaveProgramCard({
        clientId,
        requestId,
        appId: msg.appId === undefined ? null : msg.appId,
        ...(typeof msg.sourceAppId === "string" ? { sourceAppId: msg.sourceAppId } : {}),
        name: msg.name,
        card: msg.card,
        state: msg.state,
        ...(msg.draft && typeof msg.draft === "object" ? { draft: msg.draft } : {}),
        ...(msg.mode !== undefined && msg.mode !== null ? { mode: msg.mode } : {}),
        ...(typeof msg.by === "string" ? { by: msg.by } : {}),
        ...(typeof msg.note === "string" ? { note: msg.note } : {}),
        ...(msg.asks !== undefined ? { asks: msg.asks } : {}),
        ...(msg.error !== undefined && msg.error !== null ? { error: msg.error } : {}),
      }))
      .then(
        (result     ) => {
          const unicast = formatProgramCardSaveResult({ requestId, ...(result || {}) });
          if (!result || result.status !== "saved") return { unicast };
          return changedBroadcast(result.appId).then((broadcast) => ({
            unicast,
            ...(broadcast.length ? { broadcast } : {}),
          }));
        },
        (err     ) => {
          logger.error(`[downstream] save card failed: ${err && err.message ? err.message : err}`);
          return rejected("save_failed");
        },
      );
  }

  function handleCheckpointProgramCard(clientId     , msg     ) {
    const appId = typeof msg.appId === "string" ? msg.appId : "";
    const seq = Number.isSafeInteger(msg.seq) ? msg.seq : -1;
    if (!onCheckpointProgramCard) {
      return {
        unicast: formatProgramCardCheckpointResult({ appId, seq, status: "rejected", code: "save_unavailable" }),
      };
    }
    return Promise.resolve()
      .then(() => onCheckpointProgramCard({ clientId, appId, seq: msg.seq, state: msg.state,
        ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
        ...(msg.sourceHash !== undefined ? { sourceHash: msg.sourceHash } : {}) }))
      .then(
        (result     ) => ({
          unicast: formatProgramCardCheckpointResult({ appId, seq, ...(result || {}) }),
        }),
        (err     ) => {
          logger.error(`[downstream] card checkpoint failed: ${err && err.message ? err.message : err}`);
          return {
            unicast: formatProgramCardCheckpointResult({ appId, seq, status: "rejected", code: "save_failed" }),
          };
        },
      );
  }

  function handleOpenLiveuiLibraryItem(clientId     , msg     ) {
    const itemType = typeof msg.itemType === "string" ? msg.itemType : "";
    const itemId = typeof msg.itemId === "string" ? msg.itemId : "";
    if (itemType === "app" && onOpenProgramCard) return handleOpenProgramCard(clientId, itemId);
    if (!onOpenLiveuiLibraryItem) {
      return {
        unicast: formatLiveuiLibraryOpenResult({
          itemType,
          itemId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }

    const resultId = itemType === "template" && typeof msg.resultId === "string" && /^[A-Za-z0-9_-]{22}$/.test(msg.resultId)
      ? msg.resultId
      : null;
    return Promise.resolve(onOpenLiveuiLibraryItem({ clientId, itemType, itemId, ...(resultId ? { resultId } : {}) })).then(
      (result) => ({
        unicast: formatLiveuiLibraryOpenResult({ itemType, itemId, ...(result || {}) }),
      }),
      (err) => {
        logger.error(`[downstream] open LiveUI Library item failed: ${err.message}`);
        return {
          unicast: formatLiveuiLibraryOpenResult({
            itemType,
            itemId,
            status: "rejected",
            code: "template_open_failed",
          }),
        };
      },
    );
  }

  function handleCancelLiveuiTaskLaunch(clientId     , msg     ) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    if (!onCancelLiveuiTaskLaunch) return null;
    try {
      const result = onCancelLiveuiTaskLaunch({ clientId, taskId });
      if (result && typeof result.then === "function") {
        return result.then(
          () => null,
          (err     ) => {
            logger.warn(
              `[downstream] cancel LiveUI Task launch failed: ${err && err.message ? err.message : err}`,
            );
            return null;
          },
        );
      }
      return null;
    } catch (err     ) {
      logger.warn(
        `[downstream] cancel LiveUI Task launch failed: ${err && err.message ? err.message : err}`,
      );
      return null;
    }
  }

  function handleGetLiveuiTasksForPhone(clientId     ) {
    if (!onGetLiveuiTasksForPhone) {
      return { unicast: formatLiveuiTasks({ tasks: [], templates: [], invalid: [] }) };
    }
    return Promise.resolve(onGetLiveuiTasksForPhone()).then(
      (payload) => ({ unicast: formatLiveuiTasks(payload || {}) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Tasks failed: ${err.message}`);
        return { unicast: formatLiveuiTasks({ tasks: [], templates: [], invalid: [] }) };
      },
    );
  }

  function handleGetLiveuiTaskRunsForPhone(clientId     , msg     ) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId.trim() : "";
    if (!isPhoneClient(clientId)) {
      return { unicast: formatError("liveui_task_runs_phone_only", {}) };
    }
    if (!taskId) {
      return { unicast: formatError("liveui_task_runs_task_id_required", {}) };
    }
    if (!onGetLiveuiTaskRunsForPhone) {
      return { unicast: formatLiveuiTaskRuns(taskId, []) };
    }
    return Promise.resolve(onGetLiveuiTaskRunsForPhone(taskId)).then(
      (records) => ({ unicast: formatLiveuiTaskRuns(taskId, records) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Task Runs failed: ${err.message}`);
        return { unicast: formatLiveuiTaskRuns(taskId, []) };
      },
    );
  }

  function handleReviewLiveuiTask(clientId     , msg     ) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const action = typeof msg.action === "string" ? msg.action : "";
    const expectedDigest = typeof msg.expectedDigest === "string" ? msg.expectedDigest : "";
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiTaskReview)) {
      return {
        unicast: formatLiveuiTaskReviewAck({
          taskId,
          action,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onReviewLiveuiTask) {
      return {
        unicast: formatLiveuiTaskReviewAck({
          taskId,
          action,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] review LiveUI Task failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskReviewAck({
          taskId,
          action,
          status: "rejected",
          code: "task_review_failed",
        }),
      };
    };

    const cardLinkDigest = typeof msg.cardLinkDigest === "string" ? msg.cardLinkDigest : undefined;
    return Promise.resolve(onReviewLiveuiTask({
      clientId,
      taskId,
      action,
      expectedDigest,
      ...(cardLinkDigest !== undefined ? { cardLinkDigest } : {}),
    })).then(
      (result) => {
        const ack = formatLiveuiTaskReviewAck({ taskId, action, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleGetLiveuiTaskExecutors(clientId     ) {
    if (!isPhoneClient(clientId)) {
      return { unicast: formatError("phone_only", { code: "phone_only" }) };
    }
    if (!onGetLiveuiTaskExecutors) {
      return { unicast: formatLiveuiTaskExecutors({ executors: [] }) };
    }
    return Promise.resolve(onGetLiveuiTaskExecutors()).then(
      (payload) => ({ unicast: formatLiveuiTaskExecutors(payload || {}) }),
      (err) => {
        logger.error(`[downstream] get LiveUI Task Executors failed: ${err.message}`);
        return { unicast: formatLiveuiTaskExecutors({ executors: [] }) };
      },
    );
  }

  function handleSetLiveuiTaskExecutor(clientId     , msg     ) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const executor = msg.executor && typeof msg.executor === "object"
      ? {
          host: typeof msg.executor.host === "string" ? msg.executor.host : "",
          agentId: typeof msg.executor.agentId === "string" ? msg.executor.agentId : "",
        }
      : { host: "", agentId: "" };
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiTaskExecutorSet)) {
      return {
        unicast: formatLiveuiTaskExecutorAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskExecutor) {
      return {
        unicast: formatLiveuiTaskExecutorAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] set LiveUI Task Executor failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskExecutorAck({
          taskId,
          status: "rejected",
          code: "task_executor_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskExecutor({ clientId, taskId, executor })).then(
      (result) => {
        const ack = formatLiveuiTaskExecutorAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiTaskPreferredTemplate(clientId     , msg     ) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const expectedDigest = typeof msg.expectedDigest === "string" ? msg.expectedDigest : "";
    const templateId = msg.templateId === null
      ? null
      : typeof msg.templateId === "string"
        ? msg.templateId
        : "";
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiTaskPreferredTemplateSet)) {
      return {
        unicast: formatLiveuiTaskPreferredTemplateAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskPreferredTemplate) {
      return {
        unicast: formatLiveuiTaskPreferredTemplateAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] set LiveUI Task Preferred Template failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskPreferredTemplateAck({
          taskId,
          status: "rejected",
          code: "task_preferred_template_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskPreferredTemplate({
      clientId,
      taskId,
      expectedDigest,
      templateId,
    })).then(
      (result) => {
        const ack = formatLiveuiTaskPreferredTemplateAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiTaskContext(clientId     , msg     ) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const context = typeof msg.context === "string" ? msg.context : "";
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiTaskContextSet)) {
      return {
        unicast: formatLiveuiTaskContextAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskContext) {
      return {
        unicast: formatLiveuiTaskContextAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] set LiveUI Task context failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskContextAck({
          taskId,
          status: "rejected",
          code: "task_context_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskContext({ clientId, taskId, context })).then(
      (result) => {
        const ack = formatLiveuiTaskContextAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleGetLiveuiPrefs(clientId     ) {
    if (!isPhoneClient(clientId)) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "phone_only" }) };
    }
    if (!onGetLiveuiPrefs) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "item_unavailable" }) };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] get LiveUI prefs failed: ${err.message}`);
      return {
        unicast: formatError("LiveUI prefs unavailable", {
          code: "prefs_read_failed",
          op: "ocuclaw.liveui.prefs.get",
        }),
      };
    };
    return Promise.resolve().then(() => onGetLiveuiPrefs()).then(
      (result     ) => ({
        unicast: formatLiveuiPrefs({
          ...((result && result.prefs) || {}),
          ...(result && result.prefsInvalid ? { prefsInvalid: result.prefsInvalid } : {}),
        }),
      }),
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiPrefs(clientId     , msg     ) {
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiPrefsSet)) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "phone_only" }) };
    }
    if (!onSetLiveuiPrefs) {
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "item_unavailable" }) };
    }
    const patch      = {};
    if (typeof msg.enabled === "boolean") patch.enabled = msg.enabled;
    if (typeof msg.pauseApps === "boolean") patch.pauseApps = msg.pauseApps;
    if (typeof msg.titleIcons === "boolean") patch.titleIcons = msg.titleIcons;
    if (typeof msg.videoSpeed === "boolean") patch.videoSpeed = msg.videoSpeed;

    if (typeof msg.videoSize === "number") patch.videoSize = msg.videoSize;

    if (Object.prototype.hasOwnProperty.call(msg, "videoSubtitles")) patch.videoSubtitles = msg.videoSubtitles;
    if (typeof msg.defaultContext === "string") patch.defaultContext = msg.defaultContext;
    if (msg.defaultExecutor === null || typeof msg.defaultExecutor === "string") {
      patch.defaultExecutor = msg.defaultExecutor;
    }
    const failure = (err     ) => {
      logger.error(`[downstream] set LiveUI prefs failed: ${err.message}`);
      return { unicast: formatLiveuiPrefsAck({ status: "rejected", code: "prefs_update_failed" }) };
    };
    return Promise.resolve(onSetLiveuiPrefs({ clientId, patch })).then(
      (result     ) => {
        const ack = formatLiveuiPrefsAck(result || {});
        if (!result || result.status !== "accepted") return { unicast: ack };

        return Promise.resolve(onGetLiveuiStatus ? onGetLiveuiStatus() : null).then((status) => ({
          unicast: ack,
          broadcast: [
            formatLiveuiPrefs(result.prefs || {}),
            ...(status ? [formatLiveuiStatus(status)] : []),
          ],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleGetLiveuiGrants(clientId     ) {
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatLiveuiGrantsAck({ status: "rejected", code: "phone_only" }),
      };
    }
    if (!onGetLiveuiGrants) {
      return {
        unicast: formatLiveuiGrantsAck({ status: "rejected", code: "item_unavailable" }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] get LiveUI grants failed: ${err.message}`);
      return {
        unicast: formatError("LiveUI grants unavailable", {
          code: "grants_read_failed",
          op: APP_PROTOCOL.liveuiGrantsGet,
        }),
      };
    };
    return Promise.resolve().then(() => onGetLiveuiGrants()).then(
      (result     ) => {
        if (result && result.status === "rejected") {
          return {
            unicast: formatLiveuiGrantsAck({
              status: "rejected",
              code: result.code || "item_unavailable",
            }),
          };
        }
        return { unicast: formatLiveuiGrantsSnapshot(result || {}) };
      },
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiGrant(clientId     , msg     ) {
    const action = typeof msg.action === "string" ? msg.action : "";
    const host = typeof msg.host === "string" ? msg.host : "";
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiGrantsSet)) {
      return {
        unicast: formatLiveuiGrantsAck({ action, host, status: "rejected", code: "phone_only" }),
      };
    }
    if (!onSetLiveuiGrant) {
      return {
        unicast: formatLiveuiGrantsAck({
          action,
          host,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    if (action !== "allow" && action !== "deny" && action !== "remove") {
      return {
        unicast: formatLiveuiGrantsAck({
          action,
          host,
          status: "rejected",
          code: "grant_invalid_action",
        }),
      };
    }
    if (typeof msg.host !== "string") {
      return {
        unicast: formatLiveuiGrantsAck({
          action,
          host,
          status: "rejected",
          code: "grant_invalid_host",
        }),
      };
    }
    if (msg.baseDigest !== null && typeof msg.baseDigest !== "string") {
      return {
        unicast: formatLiveuiGrantsAck({
          action,
          host,
          status: "rejected",
          code: "grant_base_required",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] set LiveUI grant failed: ${err.message}`);
      return {
        unicast: formatLiveuiGrantsAck({
          action,
          host,
          status: "rejected",
          code: "grants_write_failed",
        }),
      };
    };
    return Promise.resolve().then(() => onSetLiveuiGrant({
      clientId,
      action,
      host,
      baseDigest: msg.baseDigest,
    })).then(
      (result     ) => {
        const ack = formatLiveuiGrantsAck({ ...(result || {}), action, host });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return {
          unicast: ack,
          broadcast: [formatLiveuiGrantsSnapshot(result.snapshot || {})],
        };
      },
      failure,
    ).catch(failure);
  }

  function handleGetLiveuiStatus(clientId     ) {
    if (!isPhoneClient(clientId)) {
      return {
        unicast: formatError("LiveUI status is phone-only", {
          code: "phone_only",
          op: "ocuclaw.liveui.status.get",
        }),
      };
    }
    if (!onGetLiveuiStatus) {
      return {
        unicast: formatError("LiveUI status unavailable", {
          code: "item_unavailable",
          op: "ocuclaw.liveui.status.get",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] get LiveUI status failed: ${err.message}`);
      return {
        unicast: formatError("LiveUI status unavailable", {
          code: "status_read_failed",
          op: "ocuclaw.liveui.status.get",
        }),
      };
    };
    return Promise.resolve().then(() => onGetLiveuiStatus()).then(
      (status     ) => ({ unicast: formatLiveuiStatus(status || {}) }),
      failure,
    ).catch(failure);
  }

  function handleSetLiveuiTaskSettingValues(clientId     , msg     ) {
    const taskId = typeof msg.taskId === "string" ? msg.taskId : "";
    const expectedDigest = typeof msg.expectedDigest === "string" ? msg.expectedDigest : "";
    const values = msg.values && typeof msg.values === "object" && !Array.isArray(msg.values)
      ? msg.values
      : {};
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiTaskSettingsSet)) {
      return {
        unicast: formatLiveuiTaskSettingsAck({
          taskId,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onSetLiveuiTaskSettingValues) {
      return {
        unicast: formatLiveuiTaskSettingsAck({
          taskId,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] set LiveUI Task Settings failed: ${err.message}`);
      return {
        unicast: formatLiveuiTaskSettingsAck({
          taskId,
          status: "rejected",
          code: "task_setting_values_update_failed",
        }),
      };
    };
    return Promise.resolve(onSetLiveuiTaskSettingValues({
      clientId,
      taskId,
      expectedDigest,
      values,
    })).then(
      (result) => {
        const ack = formatLiveuiTaskSettingsAck({ taskId, ...(result || {}) });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([tasks, library]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(tasks || {}), formatLiveuiLibrary(library)],
        }));
      },
      failure,
    ).catch(failure);
  }

  function handleOrganizeLiveuiLibrary(clientId     , msg     ) {
    const params = {
      clientId,
      action: typeof msg.action === "string" ? msg.action : "",
      expectedDigest: typeof msg.expectedDigest === "string" ? msg.expectedDigest : "",
      ...(typeof msg.itemType === "string" ? { itemType: msg.itemType } : {}),
      ...(typeof msg.itemId === "string" ? { itemId: msg.itemId } : {}),
      ...(Array.isArray(msg.order) ? { order: msg.order } : {}),
      ...(Object.prototype.hasOwnProperty.call(msg, "name") ? { name: msg.name } : {}),
      ...(Object.prototype.hasOwnProperty.call(msg, "description")
        ? { description: msg.description }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(msg, "icon") ? { icon: msg.icon } : {}),
    };
    if (!admitPhoneOnlyWrite(clientId, APP_PROTOCOL.liveuiLibraryOrganize)) {
      return {
        unicast: formatLiveuiLibraryOrganizeAck({
          action: params.action,
          status: "rejected",
          code: "phone_only",
        }),
      };
    }
    if (!onOrganizeLiveuiLibrary) {
      return {
        unicast: formatLiveuiLibraryOrganizeAck({
          action: params.action,
          status: "rejected",
          code: "item_unavailable",
        }),
      };
    }
    const failure = (err     ) => {
      logger.error(`[downstream] organize LiveUI Library failed: ${err.message}`);
      return {
        unicast: formatLiveuiLibraryOrganizeAck({
          action: params.action,
          status: "rejected",
          code: "library_organize_failed",
        }),
      };
    };
    return Promise.resolve(onOrganizeLiveuiLibrary(params)).then(
      (result) => {
        const ack = formatLiveuiLibraryOrganizeAck({
          action: params.action,
          ...(result || {}),
        });
        if (!result || result.status !== "accepted") return { unicast: ack };
        return Promise.all([
          onGetLiveuiTasksForPhone ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve({}),
          onGetLiveuiLibrary ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve([]),
        ]).then(([phone, glasses]) => ({
          unicast: ack,
          broadcast: [formatLiveuiTasks(phone || {}), formatLiveuiLibrary(glasses)],
        }));
      },
      failure,
    ).catch(failure);
  }

  return {
    handleGetLiveuiLibrary,
    handleOpenLiveuiLibraryItem,
    handleSaveProgramCard,
    handleCheckpointProgramCard,
    handleGetProgramCardSource,
    handleGetProgramCardRevisions,
    handleProgramCardRevision,
    handleProgramCardReview,
    handleProgramCardReviewLookStep,
    handleProgramCardRevisionPicture,
    handleGetProgramCardSlots,
    handleProgramCardSlot,
    handleProgramCardReviewApply,
    handleCancelLiveuiTaskLaunch,
    handleGetLiveuiTasksForPhone,
    handleGetLiveuiTaskRunsForPhone,
    handleReviewLiveuiTask,
    handleGetLiveuiTaskExecutors,
    handleSetLiveuiTaskExecutor,
    handleSetLiveuiTaskPreferredTemplate,
    handleSetLiveuiTaskContext,
    handleGetLiveuiPrefs,
    handleSetLiveuiPrefs,
    handleGetLiveuiGrants,
    handleSetLiveuiGrant,
    handleGetLiveuiStatus,
    handleSetLiveuiTaskSettingValues,
    handleOrganizeLiveuiLibrary,
    handleLiveuiVideoRoute,
  };
}

module.exports = { createLiveuiHandlers };
