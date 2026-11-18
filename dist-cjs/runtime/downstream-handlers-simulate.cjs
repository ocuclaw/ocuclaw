const { formatSendAckCompat } = require("./downstream-codec-core.cjs");
const { parseOptionalTrimmedString, parseOptionalPositiveNumber, parseOptionalNonNegativeNumber } = require("./downstream-parse-optional.cjs");
const { normalizeSessionListFixture } = require("./session-list-fixture.cjs");

const SIMULATED_RUN_SIGNALS = new Set(["model_call", "compaction", "subagent", "retry_wait"]);

function createSimulateHandlers({
  formatPages,
  resolveInjectedLiveUiSession,
  onSimulate,
  onSimulateStream,
  onSimulateStreamCancel,
  onSimulateActivity,
  onSimulateThinking,
  onSimulateRunSignal,
  onSimulateModelCatalog,
  onSimulateSessionList,
  onSimulateTool,
  onSimulateApproval,
  onSimulateDemand,
  onSimulateVoice,
  onGlassesUiSurfaceUpdateInject,
}     ) {

  function handleSimulate(clientId, msg) {
    const pages = onSimulate(
      msg.sender || "Simulator",
      msg.text || "",
      parseOptionalTrimmedString(msg.id) || undefined,
    );
    return { broadcast: formatPages(pages) };
  }

  function handleSimulateStream(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }

    if (!onSimulateStream) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStream not supported by relay",
        ),
      };
    }

    const text = typeof msg.text === "string" ? msg.text : "";
    if (!text.trim()) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStream requires non-empty text",
        ),
      };
    }

    let chunkChars;
    let chunkIntervalMs;
    let startDelayMs;
    let thinkingTailMs;
    try {
      chunkChars = parseOptionalPositiveNumber(msg.chunkChars, "chunkChars");
      chunkIntervalMs = parseOptionalPositiveNumber(msg.chunkIntervalMs, "chunkIntervalMs");
      startDelayMs = parseOptionalNonNegativeNumber(msg.startDelayMs, "startDelayMs");
      thinkingTailMs = parseOptionalNonNegativeNumber(msg.thinkingTailMs, "thinkingTailMs");
    } catch (err) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "Invalid simulateStream parameters",
        ),
      };
    }

    const messageKind = parseOptionalTrimmedString(msg.messageKind);
    if (messageKind && messageKind !== "narration") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStream messageKind must be narration when set",
          undefined,
        ),
      };
    }

    const request = {
      id,

      sender:
        parseOptionalTrimmedString(msg.sender) ||
        (msg.nativeLifecycle === true ? null : "Simulator"),
      text,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      chunkChars,
      chunkIntervalMs,
      startDelayMs,
      thinkingTailMs,
      runId: parseOptionalTrimmedString(msg.runId) || null,
      nativeLifecycle: msg.nativeLifecycle === true,

      continuesRun: msg.continuesRun === true,

      messageKind: messageKind || null,
      messageId: parseOptionalTrimmedString(msg.messageId) || null,
    };

    return Promise.resolve(onSimulateStream(request)).then(
      (result) => {
        const status = result && result.status ? result.status : "accepted";
        const error = result && result.error ? result.error : undefined;
        const errorCode = result && result.errorCode ? result.errorCode : undefined;
        const runId = result && result.runId ? result.runId : request.runId;
        return { unicast: formatSendAckCompat(id, status, error, errorCode, { runId }) };
      },
      (err) => ({
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "simulateStream failed",
          err && err.code ? err.code : undefined,
        ),
      }),
    );
  }

  function handleSimulateStreamCancel(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
          "missing_id",
        ),
      };
    }

    const runId = parseOptionalTrimmedString(msg.runId);
    if (!runId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStreamCancel requires non-empty runId",
          "missing_run_id",
        ),
      };
    }

    if (!onSimulateStreamCancel) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateStreamCancel not supported by relay",
          "unsupported_operation",
          { runId },
        ),
      };
    }

    const request = {
      id,
      runId,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
    };
    return Promise.resolve(onSimulateStreamCancel(request)).then(
      (result) => {
        const status = result && result.status ? result.status : "accepted";
        const error = result && result.error ? result.error : undefined;
        const errorCode = result && result.errorCode ? result.errorCode : undefined;
        return {
          unicast: formatSendAckCompat(id, status, error, errorCode, { runId }),
        };
      },
      (err) => ({
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "simulateStreamCancel failed",
          err && err.code ? err.code : undefined,
          { runId },
        ),
      }),
    );
  }

  function ackSimulateVerb(id, verb, callbackResult) {
    return Promise.resolve(callbackResult).then(
      (result) => {
        const status = result && result.status ? result.status : "accepted";
        const error = result && result.error ? result.error : undefined;
        const errorCode = result && result.errorCode ? result.errorCode : undefined;
        return { unicast: formatSendAckCompat(id, status, error, errorCode) };
      },
      (err) => ({
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : `${verb} failed`,
        ),
      }),
    );
  }

  function handleSimulateActivity(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateActivity) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateActivity not supported by relay",
        ),
      };
    }
    const state = parseOptionalTrimmedString(msg.state);
    if (state !== "thinking" && state !== "idle") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateActivity state must be thinking|idle",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateActivity", onSimulateActivity({
      id,
      state,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      runId: parseOptionalTrimmedString(msg.runId) || null,
      summary: parseOptionalTrimmedString(msg.summary) || null,
      nativeLifecycle: msg.nativeLifecycle === true,
    }));
  }

  function handleSimulateModelCatalog(msg) {

    const reject = (ackId, reason) => ({
      unicast: formatSendAckCompat(ackId, "rejected", reason, undefined),
    });
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) return reject(msg.id || null, "Missing required field: id");
    if (!onSimulateModelCatalog) {
      return reject(id, "simulateModelCatalog not supported by relay");
    }
    let models = null;
    if (msg.models !== undefined && msg.models !== null) {
      if (!Array.isArray(msg.models)) {
        return reject(id, "simulateModelCatalog models must be an array or null");
      }
      models = [];
      for (const row of msg.models) {
        const provider = parseOptionalTrimmedString(row && row.provider);
        const modelId = parseOptionalTrimmedString(row && row.id);
        if (!provider || !modelId) {
          return reject(
            id,
            "simulateModelCatalog rows need a non-empty provider and id",
          );
        }
        models.push({
          provider,
          id: modelId,
          name: parseOptionalTrimmedString(row.name) || modelId,
          ...(Number.isFinite(row.contextWindow)
            ? { contextWindow: Math.floor(row.contextWindow) }
            : {}),
          ...(typeof row.reasoning === "boolean" ? { reasoning: row.reasoning } : {}),
        });
      }
    }
    return ackSimulateVerb(id, "simulateModelCatalog", onSimulateModelCatalog({
      id,
      models,
    }));
  }

  function handleSimulateSessionList(msg) {
    const reject = (ackId, reason) => ({
      unicast: formatSendAckCompat(ackId, "rejected", reason, undefined),
    });
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) return reject(msg.id || null, "Missing required field: id");
    if (!onSimulateSessionList) {
      return reject(id, "simulateSessionList not supported by relay");
    }
    let rows = null;
    if (msg.rows !== undefined && msg.rows !== null) {
      const normalized = normalizeSessionListFixture(msg.rows);
      if (!normalized.ok) {
        return reject(id, `simulateSessionList ${normalized.error}`);
      }
      rows = msg.rows;
    }
    return Promise.resolve(onSimulateSessionList({ id, rows })).then(
      (result) => {
        const status = result && result.status ? result.status : "accepted";
        const ack = JSON.parse(
          formatSendAckCompat(id, status, result && result.error ? result.error : undefined),
        );
        if (result && result.sessionList) ack.sessionList = result.sessionList;
        return { unicast: JSON.stringify(ack) };
      },
      (err) => reject(id, err && err.message ? err.message : "simulateSessionList failed"),
    );
  }

  function handleSimulateTool(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateTool) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool not supported by relay",
        ),
      };
    }
    const runId = parseOptionalTrimmedString(msg.runId);
    if (!runId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool requires runId (pairs start/result)",
        ),
      };
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (phase !== "start" && phase !== "result") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool phase must be start|result",
        ),
      };
    }
    const tool = parseOptionalTrimmedString(msg.tool);
    if (!tool) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateTool requires tool (real tool name, label derives relay-side)",
        ),
      };
    }
    let elapsedMs;
    try {
      elapsedMs = parseOptionalNonNegativeNumber(msg.elapsedMs, "elapsedMs");
    } catch (err) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "Invalid simulateTool parameters",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateTool", onSimulateTool({
      id,
      runId,
      phase,
      tool,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      argsPreview:
        msg.argsPreview &&
        typeof msg.argsPreview === "object" &&
        !Array.isArray(msg.argsPreview)
          ? msg.argsPreview
          : null,
      isError: msg.isError === true,
      elapsedMs,
      toolPhase: msg.toolPhase === true,
      toolCallId: parseOptionalTrimmedString(msg.toolCallId) || null,
      nativeLifecycle: msg.nativeLifecycle === true,
    }));
  }

  function handleSimulateThinking(clientId = "", msg = JSON.parse("{}")) {

    const reject = (ackId = JSON.parse("null"), reason = "") => ({
      unicast: formatSendAckCompat(ackId, "rejected", reason, undefined),
    });
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) return reject(msg.id || null, "Missing required field: id");
    if (!onSimulateThinking) return reject(id, "simulateThinking not supported by relay");
    const runId = parseOptionalTrimmedString(msg.runId);
    if (!runId) {
      return reject(id, "simulateThinking requires runId (thinking frames are run-scoped)");
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (phase !== "update" && phase !== "finalize") {
      return reject(id, "simulateThinking phase must be update|finalize");
    }
    const delta = typeof msg.delta === "string" ? msg.delta : "";
    if (phase === "update" && !delta.trim()) {
      return reject(id, "simulateThinking update requires a non-empty delta");
    }
    return ackSimulateVerb(id, "simulateThinking", onSimulateThinking({
      id,
      runId,
      phase,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      delta: phase === "update" ? delta : null,
      reason: phase === "finalize"
        ? parseOptionalTrimmedString(msg.reason) || "response_started"
        : null,
    }));
  }

  function handleSimulateRunSignal(clientId = "", msg = JSON.parse("{}")) {
    const reject = (ackId = JSON.parse("null"), reason = "") => ({
      unicast: formatSendAckCompat(ackId, "rejected", reason, undefined),
    });
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) return reject(msg.id || null, "Missing required field: id");
    if (!onSimulateRunSignal) return reject(id, "simulateRunSignal not supported by relay");
    const signal = parseOptionalTrimmedString(msg.signal);
    if (!signal || !SIMULATED_RUN_SIGNALS.has(signal)) {
      return reject(id, "simulateRunSignal signal must be model_call|compaction|subagent|retry_wait");
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (phase !== "start" && phase !== "end") {
      return reject(id, "simulateRunSignal phase must be start|end");
    }
    const waitMs = msg.waitMs;
    if (waitMs !== undefined && !(typeof waitMs === "number" && Number.isFinite(waitMs) && waitMs >= 0)) {
      return reject(id, "simulateRunSignal waitMs must be a non-negative number");
    }
    return ackSimulateVerb(id, "simulateRunSignal", onSimulateRunSignal({
      id,
      signal,
      phase,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      runId: parseOptionalTrimmedString(msg.runId) || null,
      spanId: parseOptionalTrimmedString(msg.spanId) || null,
      outcome: parseOptionalTrimmedString(msg.outcome) || null,
      reason: parseOptionalTrimmedString(msg.reason) || null,
      label: parseOptionalTrimmedString(msg.label) || null,
      waitMs: typeof waitMs === "number" ? waitMs : null,
    }));
  }

  function handleSimulateApproval(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateApproval) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval not supported by relay",
        ),
      };
    }
    const approvalId = parseOptionalTrimmedString(msg.approvalId);
    if (!approvalId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval requires approvalId (pairs request/resolve)",
        ),
      };
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (phase !== "request" && phase !== "resolve") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval phase must be request|resolve",
        ),
      };
    }
    if (phase === "request") {
      const command = parseOptionalTrimmedString(msg.command);
      if (!command) {
        return {
          unicast: formatSendAckCompat(
            id,
            "rejected",
            "simulateApproval request requires command",
          ),
        };
      }
      let expiresInMs;
      try {
        expiresInMs = parseOptionalPositiveNumber(msg.expiresInMs, "expiresInMs");
      } catch (err) {
        return {
          unicast: formatSendAckCompat(
            id,
            "rejected",
            err && err.message ? err.message : "Invalid simulateApproval parameters",
          ),
        };
      }
      const allowedDecisions =
        Array.isArray(msg.allowedDecisions) &&
        msg.allowedDecisions.some((d) => typeof d === "string")
          ? msg.allowedDecisions.filter((d) => typeof d === "string")
          : ["allow-once", "deny"];
      return ackSimulateVerb(id, "simulateApproval", onSimulateApproval({
        id,
        phase,
        approvalId,
        command,
        ask: parseOptionalTrimmedString(msg.ask) || null,

        warningText: parseOptionalTrimmedString(msg.warningText) || null,
        warningLines: Array.isArray(msg.warningLines)
          ? msg.warningLines.filter((line         ) => typeof line === "string")
          : [],
        allowedDecisions,
        expiresInMs: expiresInMs || 120000,
        sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
        cwd: parseOptionalTrimmedString(msg.cwd) || null,
        agentId: parseOptionalTrimmedString(msg.agentId) || null,

        purpose: parseOptionalTrimmedString(msg.purpose) || null,
        explanation: parseOptionalTrimmedString(msg.explanation) || null,
        explanationDelayMs:
          typeof msg.explanationDelayMs === "number" && msg.explanationDelayMs >= 0
            ? msg.explanationDelayMs
            : 1500,

        botScreen:
          msg.botScreen && typeof msg.botScreen === "object" && !Array.isArray(msg.botScreen)
            ? msg.botScreen
            : null,
        nativeLifecycle: msg.nativeLifecycle === true,
      }));
    }
    const decision = parseOptionalTrimmedString(msg.decision);
    if (!decision) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateApproval resolve requires decision",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateApproval", onSimulateApproval({
      id,
      phase,
      approvalId,
      decision,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
      nativeLifecycle: msg.nativeLifecycle === true,
    }));
  }

  function handleSimulateDemand(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateDemand) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand not supported by relay",
        ),
      };
    }
    const surfaceId = parseOptionalTrimmedString(msg.surfaceId);
    if (!surfaceId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand requires surfaceId",
        ),
      };
    }
    const question = parseOptionalTrimmedString(msg.question);
    if (!question) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand requires question",
        ),
      };
    }
    const options = Array.isArray(msg.options)
      ? msg.options
          .map((option) => ({
            label: parseOptionalTrimmedString(option && option.label) || "",
            detail: parseOptionalTrimmedString(option && option.detail) || null,
          }))
          .filter((option) => option.label)
      : [];

    let presentationError = null;
    if (
      msg.presentation !== undefined &&
      msg.presentation !== "reel" &&
      msg.presentation !== "adaptive"
    ) {
      presentationError = "simulateDemand presentation must be reel or adaptive";
    } else if (
      msg.selectionMode !== undefined &&
      msg.selectionMode !== "single" &&
      msg.selectionMode !== "multi" &&
      msg.selectionMode !== "open"
    ) {
      presentationError = "simulateDemand selectionMode must be single, multi, or open";
    } else if (msg.allowOther !== undefined && typeof msg.allowOther !== "boolean") {
      presentationError = "simulateDemand allowOther must be boolean";
    }
    if (presentationError) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          presentationError,
          "invalid_demand_presentation",
        ),
      };
    }
    const selectionMode = msg.selectionMode || "single";

    if (!options.length && selectionMode !== "open") {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateDemand requires at least one option with a label",
        ),
      };
    }
    return ackSimulateVerb(id, "simulateDemand", onSimulateDemand({
      id,
      surfaceId,
      question,
      options,
      kind: msg.kind === "permission" ? "permission" : "question",
      title: parseOptionalTrimmedString(msg.title) || "question",
      deadlineSec: Number.isFinite(msg.deadlineSec) && msg.deadlineSec > 0
        ? msg.deadlineSec
        : 120,

      questionIndex: Number.isInteger(msg.questionIndex) && msg.questionIndex >= 0
        ? msg.questionIndex
        : 0,
      questionCount: Number.isInteger(msg.questionCount) && msg.questionCount >= 0
        ? msg.questionCount
        : 0,
      presentation: msg.presentation || "reel",
      selectionMode,
      allowOther: msg.allowOther === true,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,
    }));
  }

  function handleSimulateVoice(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onSimulateVoice) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateVoice not supported by relay",
        ),
      };
    }
    const phase = parseOptionalTrimmedString(msg.phase);
    if (
      phase !== "arm" &&
      phase !== "disarm" &&
      phase !== "partial" &&
      phase !== "commit" &&
      phase !== "end" &&
      phase !== "reopen" &&
      phase !== "await-send"
    ) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "simulateVoice phase must be arm|disarm|partial|commit|end|reopen|await-send",
        ),
      };
    }
    const text = typeof msg.text === "string" ? msg.text : "";
    if ((phase === "partial" || phase === "commit") && !text.trim()) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          `simulateVoice ${phase} requires text`,
        ),
      };
    }
    return ackSimulateVerb(id, "simulateVoice", onSimulateVoice({
      id,
      phase,
      text,
      sessionKey: parseOptionalTrimmedString(msg.sessionKey) || null,

      ...(phase === "commit" && msg.awaitAppSend === true ? { awaitAppSend: true } : {}),
      ...(phase === "commit" && msg.forwardToAgent === true ? { forwardToAgent: true } : {}),
      ...(phase === "commit" && msg.awaitAppSend === true && parseOptionalTrimmedString(msg.runId)
        ? { runId: parseOptionalTrimmedString(msg.runId) }
        : {}),
      ...(phase === "await-send" && Number.isFinite(msg.timeoutMs) ? { timeoutMs: msg.timeoutMs } : {}),
    }));
  }

  function handleGlassesUiSurfaceUpdateInject(clientId, msg) {
    const id = parseOptionalTrimmedString(msg.id);
    if (!id) {
      return {
        unicast: formatSendAckCompat(
          msg.id || null,
          "rejected",
          "Missing required field: id",
        ),
      };
    }
    if (!onGlassesUiSurfaceUpdateInject) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "glasses_ui_surface_update not supported by relay",
        ),
      };
    }
    const surfaceId = parseOptionalTrimmedString(msg.surfaceId);
    if (!surfaceId) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "glasses_ui_surface_update requires surfaceId",
        ),
      };
    }
    const patch =
      msg.patch && typeof msg.patch === "object" && !Array.isArray(msg.patch)
        ? msg.patch
        : null;
    if (!patch || Object.keys(patch).length === 0) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          "glasses_ui_surface_update requires a non-empty patch",
        ),
      };
    }
    try {
      const liveUiSession = resolveInjectedLiveUiSession(msg.sessionKey);
      onGlassesUiSurfaceUpdateInject({
        surfaceId,
        patch,
        ...liveUiSession,
      });
    } catch (err) {
      return {
        unicast: formatSendAckCompat(
          id,
          "rejected",
          err && err.message ? err.message : "glasses_ui_surface_update failed",
        ),
      };
    }
    return { unicast: formatSendAckCompat(id, "accepted") };
  }

  return {
    handleSimulate,
    handleSimulateStream,
    handleSimulateStreamCancel,
    handleSimulateActivity,
    handleSimulateModelCatalog,
    handleSimulateSessionList,
    handleSimulateTool,
    handleSimulateThinking,
    handleSimulateRunSignal,
    handleSimulateApproval,
    handleSimulateDemand,
    handleSimulateVoice,
    handleGlassesUiSurfaceUpdateInject,
  };
}

module.exports = { createSimulateHandlers };
