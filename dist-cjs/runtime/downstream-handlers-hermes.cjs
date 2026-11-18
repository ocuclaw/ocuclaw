const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { managementRequest, validManagementRequest, managementResult, managementFailure } = require("./hermes-management.cjs");
const { boardMomentAck } = require("./hermes-board-moments.cjs");
const { unsupportedBotScreenStatus } = require("../tools/bot-screen/bot-screen-source.cjs");
const { taskPushAck } = require("./hermes-task-push.cjs");
const { formatTaskRows, taskLookSet, taskReminderAct } = require("./hermes-task-rows.cjs");
const { formatTaskSheetResult, taskSheetQuiet, taskSheetResult, taskSheetRun, taskSheetSave, taskSheetSaveRequestIdOf, taskTestRequest } = require("./hermes-task-sheet.cjs");
const { formatLiveuiLibrary, formatLiveuiTasks } = require("./downstream-codec-liveui.cjs");
const { formatTaskPage, taskPageAct, taskPageGet, taskPageReply } = require("./hermes-task-page.cjs");
const { taskProposalRequest } = require("./task-result-proposal.cjs");
const { agentDraftRequest } = require("./agent-draft.cjs");
const { taskWordsRequest } = require("./task-from-words.cjs");

function createHermesHandlers({
  logger,
  isPhoneClient,
  admitPhoneOnlyWrite,
  handleAgentCreate,
  onHermesManagement,
  getManagementBackendLabel,
  onBoardMomentAck,
  onBotScreenMessage,
  onTaskPushAck,
  onGetTaskRows,
  onSetTaskLook,
  onActTaskReminder = null,
  onTaskSheet,
  onTaskProposal,
  onTaskTest = null,
  onAgentDraft = null,
  onTaskWords = null,
  onGetLiveuiTasksForPhone = null,
  onGetLiveuiLibrary = null,
  onCreateHermesProfile,
  onWaitingAnswer,
}     ) {
  async function handleTaskProposal(clientId     , msg     ) {
    if (!admitPhoneOnlyWrite(clientId, "ocuclaw.task.proposal")) return null;
    const input = taskProposalRequest(msg);
    if (!input) return null;
    const result = typeof onTaskProposal === "function" ? await onTaskProposal(clientId, input)
      : { requestId: input.requestId, status: "unavailable" };
    return { unicast: JSON.stringify({ type: "ocuclaw.task.proposal.result", v: 1, ...result }) };
  }

  async function handleTaskTest(clientId     , msg     ) {
    if (!isPhoneClient(clientId) || typeof onTaskTest !== "function") return null;
    const request = taskTestRequest(msg);
    if (!request) return null;
    try {
      const frame = await onTaskTest(clientId, request);
      return frame && typeof frame === "object" && request.op !== "test_drop" && request.op !== "card_drop" ? { unicast: JSON.stringify(frame) } : null;
    } catch (err     ) {
      logger.warn(`[downstream] task test ${request.op} failed: ${err && err.message ? err.message : err}`);

      if (request.op === "card_save") {
        return { unicast: JSON.stringify({ type: APP_PROTOCOL.taskSheetResult, v: 1, requestId: request.requestId, op: "card",
          status: "rejected", taskId: request.taskId, code: "card_save_failed" }) };
      }

      if (request.op === "card_undo") {
        return { unicast: JSON.stringify({ type: APP_PROTOCOL.taskSheetResult, v: 1, requestId: request.requestId, op: "card_undo",
          status: "rejected", taskId: request.taskId, code: "card_undo_failed" }) };
      }
      return request.requestId
        ? { unicast: JSON.stringify({ type: APP_PROTOCOL.taskTestResult, v: 1, requestId: request.requestId,
          testId: request.testId, pass: 0, passesLeft: 0, status: "rejected", code: "test_failed",
          uses: { held: true, entries: [], needs: [], keptOff: [] } }) }
        : null;
    }
  }

  async function handleAgentDraft(clientId     , msg     ) {
    if (!admitPhoneOnlyWrite(clientId, "ocuclaw.agent.draft")) return null;
    const input = agentDraftRequest(msg);
    if (!input) return null;
    const result = typeof onAgentDraft === "function" ? await onAgentDraft(clientId, input)
      : { requestId: input.requestId, status: "unavailable" };
    return { unicast: JSON.stringify({ type: APP_PROTOCOL.agentDraftResult, v: 1, ...result }) };
  }

  async function handleTaskWords(clientId     , msg     ) {
    if (!admitPhoneOnlyWrite(clientId, "ocuclaw.task.words")) return null;
    const input = taskWordsRequest(msg);
    if (!input) return null;
    const result = typeof onTaskWords === "function" ? await onTaskWords(clientId, input)
      : { requestId: input.requestId, status: "unavailable" };
    return { unicast: JSON.stringify({ type: APP_PROTOCOL.taskWordsResult, v: 1, ...result }) };
  }

  async function handleHermesManagement(clientId     , msg     ) {
    const identity = managementRequest(msg);
    const resultType = msg?.type === APP_PROTOCOL.management ? APP_PROTOCOL.managementResult : APP_PROTOCOL.hermesManagementResult;
    const reply = (payload     ) => ({ unicast: JSON.stringify({ type: resultType, ...payload }) });
    const label = typeof getManagementBackendLabel === "function" ? getManagementBackendLabel() : undefined;
    const failure = (code     , unsupported = false) => managementFailure(identity, code, unsupported, label);
    if (!admitPhoneOnlyWrite(clientId, `${APP_PROTOCOL.hermesManagement}:${identity.operation}`)) return reply(failure("phone_only"));
    if (!validManagementRequest(identity)) return reply(failure("invalid_request"));
    if (typeof onHermesManagement !== "function") return reply(failure("unsupported", true));
    try {
      return reply(managementResult(identity, await onHermesManagement(identity), label));
    } catch (error     ) {
      return reply(failure("management_unavailable", error?.code === -32601 || error?.code === "capability_unavailable"));
    }
  }

  function handleBoardMomentAck(clientId     , msg     ) {
    if (!isPhoneClient(clientId)) return null;
    const ack = boardMomentAck(msg);
    if (!ack || typeof onBoardMomentAck !== "function") return null;
    try {
      onBoardMomentAck(ack);
    } catch (err     ) {
      logger.warn(`[downstream] board moment ack failed: ${err && err.message ? err.message : err}`);
    }
    return null;
  }

  function handleBotScreen(clientId     , msg     ) {
    if (!isPhoneClient(clientId)) return null;
    if (typeof onBotScreenMessage !== "function") {
      const asks = msg.type === APP_PROTOCOL.botScreenOpen || msg.type === APP_PROTOCOL.botScreenStatusGet;
      return asks ? { unicast: unsupportedBotScreenStatus() } : null;
    }
    try {
      const reply = onBotScreenMessage(clientId, msg);
      return typeof reply === "string" ? { unicast: reply } : null;
    } catch (err     ) {
      logger.warn(`[downstream] bot screen ${msg.type} failed: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  function handleTaskPushAck(clientId     , msg     ) {
    if (!isPhoneClient(clientId)) return null;
    const ack = taskPushAck(msg);
    if (!ack || typeof onTaskPushAck !== "function") return null;
    try {
      onTaskPushAck(ack);
    } catch (err     ) {
      logger.warn(`[downstream] task push ack failed: ${err && err.message ? err.message : err}`);
    }
    return null;
  }

  function handleTaskRowsGet(clientId     ) {
    if (!isPhoneClient(clientId) || typeof onGetTaskRows !== "function") return null;
    return Promise.resolve()
      .then(() => onGetTaskRows(clientId))
      .then(
        (rows     ) => (Array.isArray(rows) ? { unicast: formatTaskRows(rows) } : null),
        (err     ) => {
          logger.warn(`[downstream] task rows failed: ${err && err.message ? err.message : err}`);
          return null;
        },
      );
  }

  function handleTaskLookSet(clientId     , msg     ) {
    if (!isPhoneClient(clientId) || typeof onSetTaskLook !== "function") return null;
    const choice = taskLookSet(msg);
    if (!choice) return null;
    return Promise.resolve()
      .then(() => onSetTaskLook(clientId, choice))
      .then(
        (rows     ) => (Array.isArray(rows) ? { unicast: formatTaskRows(rows) } : null),
        (err     ) => {
          logger.warn(`[downstream] task look failed: ${err && err.message ? err.message : err}`);
          return null;
        },
      );
  }

  function handleTaskReminder(clientId     , msg     ) {
    if (!isPhoneClient(clientId) || typeof onActTaskReminder !== "function") return null;
    const choice = taskReminderAct(msg);
    if (!choice) return null;
    return Promise.resolve()
      .then(() => onActTaskReminder(clientId, choice))
      .then(
        (rows     ) => (Array.isArray(rows) ? { unicast: formatTaskRows(rows) } : null),
        (err     ) => {
          logger.warn(`[downstream] task reminder failed: ${err && err.message ? err.message : err}`);
          return null;
        },
      );
  }

  function withLibrary(op     , outcome     , reply     ) {
    if (op !== "save" || !outcome || outcome.status !== "saved") return reply;
    if (typeof onGetLiveuiTasksForPhone !== "function" && typeof onGetLiveuiLibrary !== "function") return reply;
    return Promise.all([
      typeof onGetLiveuiTasksForPhone === "function" ? Promise.resolve(onGetLiveuiTasksForPhone()) : Promise.resolve(null),
      typeof onGetLiveuiLibrary === "function" ? Promise.resolve(onGetLiveuiLibrary()) : Promise.resolve(null),
    ]).then(
      ([tasks, library]     ) => {
        const broadcast = [
          ...(tasks ? [formatLiveuiTasks(tasks)] : []),
          ...(Array.isArray(library) ? [formatLiveuiLibrary(library)] : []),
        ];
        return broadcast.length ? { ...reply, broadcast } : reply;
      },
      (err     ) => {
        logger.warn(`[downstream] task sheet library refresh failed: ${err && err.message ? err.message : err}`);
        return reply;
      },
    );
  }

  function handleTaskSheet(clientId     , msg     , op                          ) {
    if (!isPhoneClient(clientId) || typeof onTaskSheet !== "function") return null;
    const curated = op === "save" ? taskSheetSave(msg) : op === "run" ? taskSheetRun(msg) : taskSheetQuiet(msg);
    const requestId = curated?.requestId ?? (op === "save" ? taskSheetSaveRequestIdOf(msg) : null);
    if (!requestId) return null;
    const request = !curated ? { op: "invalid_save" }
      : op === "save" ? { op, input: curated.input } : { op, taskId: curated.taskId };
    return Promise.resolve()
      .then(() => onTaskSheet(clientId, request))
      .then(
        (outcome     ) =>
          outcome === null || outcome === undefined ? null
            : !curated ? { unicast: formatTaskSheetResult(taskSheetResult("save", requestId,
                { status: "rejected", code: "task_sheet_invalid" })) }
            : withLibrary(op, outcome, { unicast: formatTaskSheetResult(taskSheetResult(op, requestId, outcome)) }),
        (err     ) => {
          logger.warn(`[downstream] task sheet ${op} failed: ${err && err.message ? err.message : err}`);
          return { unicast: formatTaskSheetResult(taskSheetResult(op, requestId, null)) };
        },
      );
  }

  function handleTaskPage(clientId     , msg     , op                ) {
    if (!isPhoneClient(clientId) || typeof onTaskSheet !== "function") return null;
    const curated = op === "page" ? taskPageGet(msg) : taskPageAct(msg);
    if (!curated) return null;
    const request = op === "page"
      ? { op, taskId: curated.taskId }
      : {
        op,
        taskId: curated.taskId,
        action: curated.action,
        expectedDigest: curated.expectedDigest,

        ...(curated.action === "set_page" ? { monitorUrl: curated.monitorUrl } : {}),

        ...(typeof curated.useKey === "string" ? { useKey: curated.useKey } : {}),
      };
    return Promise.resolve()
      .then(() => onTaskSheet(clientId, request))
      .then(
        (outcome     ) => {
          if (outcome === null || outcome === undefined) return null;
          const reply = { unicast: formatTaskPage(taskPageReply(curated.requestId, outcome)) };
          const act = outcome && outcome.act;
          const changedLibrary = op === "act" && act && act.status === "done" &&
            ["delete", "review_starter", "approve_draft", "keep_current", "set_page"].includes(act.action);
          return changedLibrary ? withLibrary("save", { status: "saved" }, reply) : reply;
        },
        (err     ) => {
          logger.warn(`[downstream] task page ${op} failed: ${err && err.message ? err.message : err}`);
          return { unicast: formatTaskPage(taskPageReply(curated.requestId, null)) };
        },
      );
  }

  function handleCreateHermesProfile(clientId     , msg     ) {
    return handleAgentCreate(clientId, msg, {
      handler: onCreateHermesProfile,
      resultType: APP_PROTOCOL.hermesProfileCreateResult,
      unavailableMessage: "Hermes profile creation is not available.",
      failureMessage: "Hermes could not create the profile.",
    });
  }

  async function handleWaitingAnswer(clientId     , msg     ) {
    const request = parseWaitingAnswerRequest(msg);
    const requestId = request ? request.requestId : waitingAnswerRequestIdOf(msg);
    const reply = (payload     ) => ({
      unicast: formatWaitingAnswerResult({ requestId, ...payload }),
    });
    if (!request) return reply({ status: "refused", reason: "bad_request" });
    if (typeof onWaitingAnswer !== "function") {
      return reply({ status: "refused", reason: "unsupported" });
    }
    try {
      const result = await onWaitingAnswer(clientId, request);
      return reply(waitingAnswerOutcome(result));
    } catch (err     ) {
      const unsupported = err?.code === -32601 || err?.code === "capability_unavailable";
      if (!unsupported) {
        logger.warn(
          `[downstream] waiting.answer failed: ${err && err.message ? err.message : err}`,
        );
      }
      return reply({ status: "refused", reason: unsupported ? "unsupported" : "unavailable" });
    }
  }

  return {
    handleHermesManagement,
    handleBoardMomentAck,
    handleBotScreen,
    handleTaskPushAck,
    handleTaskRowsGet,
    handleTaskLookSet,
    handleTaskReminder,
    handleTaskSheet,
    handleTaskProposal,
    handleAgentDraft,
    handleTaskWords,
    handleTaskPage,
    handleTaskTest,
    handleCreateHermesProfile,
    handleWaitingAnswer,
  };
}

const WAITING_ANSWER_CHOICES = new Set(["once", "session", "always", "deny"]);
const WAITING_ANSWER_STATUSES = new Set(["answered", "already_answered", "refused"]);
const WAITING_ANSWER_KINDS = new Set(["approval", "clarify", "sudo"]);
const WAITING_ANSWER_REASON_MAX_CHARS = 500;
const WAITING_ANSWER_TEXT_MAX_CHARS = 4000;
const WAITING_ANSWER_REQUEST_ID_MAX_CHARS = 256;
const WAITING_ANSWER_CODE_RE = /^[a-z0-9_]{1,64}$/;

function waitingAnswerRequestIdOf(msg     ) {
  const raw = msg && typeof msg.requestId === "string" ? msg.requestId.trim() : "";
  return raw && raw.length <= WAITING_ANSWER_REQUEST_ID_MAX_CHARS ? raw : null;
}

function parseWaitingAnswerRequest(msg     ) {
  const requestId = waitingAnswerRequestIdOf(msg);
  if (!requestId) return null;
  const hasChoice = msg.choice !== undefined && msg.choice !== null;
  const hasAnswer = msg.answer !== undefined && msg.answer !== null;
  if (hasChoice === hasAnswer) return null;
  if (hasChoice) {
    if (typeof msg.choice !== "string" || !WAITING_ANSWER_CHOICES.has(msg.choice.trim())) return null;
    const request      = { requestId, choice: msg.choice.trim() };
    const reason = typeof msg.reason === "string" ? msg.reason.trim() : "";
    if (reason) request.reason = reason.slice(0, WAITING_ANSWER_REASON_MAX_CHARS);
    return request;
  }
  if (typeof msg.answer !== "string" || !msg.answer.trim()) return null;
  if (msg.answer.length > WAITING_ANSWER_TEXT_MAX_CHARS) return null;
  return { requestId, answer: msg.answer };
}

function waitingAnswerOutcome(result     ) {
  const status = result && typeof result.status === "string" ? result.status : "";
  if (!WAITING_ANSWER_STATUSES.has(status)) return { status: "refused", reason: "unavailable" };
  const outcome      = { status };
  const reason = result.reason;
  if (status === "refused") {
    outcome.reason = typeof reason === "string" && WAITING_ANSWER_CODE_RE.test(reason) ? reason : "unavailable";
  }
  if (typeof result.kind === "string" && WAITING_ANSWER_KINDS.has(result.kind)) outcome.kind = result.kind;
  if (typeof result.choice === "string" && WAITING_ANSWER_CHOICES.has(result.choice)) {
    outcome.choice = result.choice;
  }
  return outcome;
}

function formatWaitingAnswerResult({ requestId, status, reason, kind, choice }     ) {
  const frame      = { type: APP_PROTOCOL.waitingAnswerResult, requestId: requestId || null, status };
  if (reason) frame.reason = reason;
  if (kind) frame.kind = kind;
  if (choice) frame.choice = choice;
  return JSON.stringify(frame);
}

module.exports = { createHermesHandlers, parseWaitingAnswerRequest, waitingAnswerOutcome };
