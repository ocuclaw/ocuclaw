const { compareRungs } = require("./glasses-ui-delivery-ladder.cjs");
const { validateSettingValue } = require("./glasses-ui-library.cjs");
const { TASK_FIT_PROMPT, TASK_UNCHECKED_PROMPT } = require("./glasses-ui-task-unchecked.cjs");

const LIVEUI_TASK_RUN_STATES = Object.freeze({
  starting: "starting",
  running: "running",
  ended: "ended",
});

const LIVEUI_TASK_RUN_END_REASONS = Object.freeze([
  "cancelled",
  "dismissed",
  "session_reset",
  "glasses_disconnected",
  "host_lost",
  "no_ui",
  "render_failed",
  "launch_failed",

  "fed",
]);

function feedFromParams(feed     ) {
  if (!feed || typeof feed !== "object") return null;
  const cardId = typeof feed.cardId === "string" ? feed.cardId : "";
  const keys = Array.isArray(feed.keys) ? feed.keys.filter((key     ) => typeof key === "string" && key) : [];
  if (!cardId || keys.length === 0) return null;
  const cardName = typeof feed.cardName === "string" && feed.cardName.trim() ? feed.cardName.trim() : cardId;
  return { cardId, cardName, keys, ...(typeof feed.bindingDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(feed.bindingDigest)
    && Array.isArray(feed.inputs) ? { bindingDigest: feed.bindingDigest, inputs: feed.inputs,
      ...(feed.presentationKind === "surface" ? { presentationKind: "surface" } : {}) } : {}) };
}

function taskFeedRunMessage(feed     ) {
  if (feed.presentationKind === "surface") return `This Task has an approved reusable LiveUI presentation: ${JSON.stringify(feed.cardName)}, templateId ${JSON.stringify(feed.cardId)}. Gather the Task's data, then call manage_liveui_tasks with operation "feed_card" and values containing every key in this schema, using null for unavailable data: ${JSON.stringify(feed.inputs)}. ${TASK_FIT_PROMPT} ${TASK_UNCHECKED_PROMPT} That keeps the result for reopening. After successful delivery, render the same templateId with the values feed_card returns (fitted to the card) with manage_liveui_templates operation "render"; do not regenerate a layout. Also provide ordinary output so failures/offline display remain readable.`;
  if (feed.bindingDigest) return `This run updates the saved glasses card ${JSON.stringify(feed.cardName)}. Do not render a new surface or rewrite its program. Call manage_liveui_tasks with operation "feed_card" and values containing every key in this schema, using null for unavailable data: ${JSON.stringify(feed.inputs)}. ${TASK_FIT_PROMPT} ${TASK_UNCHECKED_PROMPT} Then give the result in ordinary output too, so it remains available when the card is closed.`;
  const values = feed.keys.map((key     ) => `"${key}": "..."`).join(", ");
  return `This run feeds the glasses card "${feed.cardName}", which is open on the glasses now. Do not render a LiveUI surface. When you have the result, call manage_liveui_tasks with operation "feed_card" and values {${values}} (each a short line of text), then answer in one short sentence.`;
}

function projectLiveuiTaskRunForPhone(run     ) {
  if (!run || typeof run !== "object") return null;
  const taskId = typeof run.taskId === "string" ? run.taskId : "";
  const runId = typeof run.runId === "string" ? run.runId : "";
  if (!taskId || !runId) return null;
  return {
    taskId,
    runId,
    since: Number.isSafeInteger(run.startedAt) ? run.startedAt : 0,
    executor:
      run.executor && typeof run.executor.agentId === "string" ? run.executor.agentId : "",
  };
}

function rejected(taskId     , code     ) {
  return {
    itemType: "task",
    itemId: typeof taskId === "string" ? taskId : "",
    status: "rejected",
    code,
  };
}

function copyExecutor(value     ) {
  return {
    host: value.host,
    agentId: value.agentId,
  };
}

function approvedVersionFromLoad(loaded     ) {
  if (
    !loaded ||
    loaded.status !== "accepted" ||
    !loaded.task ||
    !loaded.task.versions ||
    !loaded.task.versions.approved
  ) return null;
  const version = loaded.task.versions.approved;
  if (
    typeof version.versionId !== "string" ||
    typeof version.request !== "string" ||
    !version.request.trim() ||
    !version.executor ||
    typeof version.executor.host !== "string" ||
    typeof version.executor.agentId !== "string" ||
    !version.executor.agentId.trim()
  ) return null;
  return version;
}

function taskRunStartMessage(version     , settingValues      = {}) {
  if (!version || !Array.isArray(version.settings) || version.settings.length === 0) {
    return version.request;
  }
  const source = settingValues && typeof settingValues === "object" && !Array.isArray(settingValues)
    ? settingValues
    : {};
  const lines = [version.request, "", "Task settings (set by the owner on the phone):"];
  for (const contractEntry of version.settings) {
    const label = typeof contractEntry.label === "string" && contractEntry.label
      ? contractEntry.label
      : contractEntry.key;
    const hasValue = Object.prototype.hasOwnProperty.call(source, contractEntry.key);
    const validation      = hasValue
      ? validateSettingValue(contractEntry, source[contractEntry.key])
      : null;
    let rendered;
    if (validation && validation.status === "accepted") {
      rendered = contractEntry.type === "string"
        ? JSON.stringify(validation.value)
        : String(validation.value);
    } else {
      rendered = contractEntry.required === true
        ? "not set — required; ask the user in this conversation if you need it"
        : "not set — optional";
    }
    lines.push(`- ${label} (${contractEntry.key}): ${rendered}`);
  }
  return lines.join("\n");
}

function normalizeSessionKey(value     ) {
  return typeof value === "string" ? value.trim() : "";
}

function createLiveuiTaskRunController(opts      = {}) {
  if (typeof opts.loadTask !== "function") {
    throw new Error("LiveUI Task Run requires loadTask");
  }
  if (typeof opts.resolveExecutor !== "function") {
    throw new Error("LiveUI Task Run requires resolveExecutor");
  }
  if (typeof opts.createSession !== "function") {
    throw new Error("LiveUI Task Run requires createSession");
  }
  if (typeof opts.sendUserMessage !== "function") {
    throw new Error("LiveUI Task Run requires sendUserMessage");
  }

  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const newRunId = typeof opts.newRunId === "function"
    ? opts.newRunId
    : () => `task-run-${now()}-${Math.random().toString(36).slice(2, 10)}`;
  const host = typeof opts.host === "string" ? opts.host : "";
  const resolveCurrentSession = typeof opts.resolveCurrentSession === "function"
    ? opts.resolveCurrentSession
    : null;
  const onRunEnded = typeof opts.onRunEnded === "function" ? opts.onRunEnded : () => {};

  const onRunStarted = typeof opts.onRunStarted === "function" ? opts.onRunStarted : () => {};
  const abortSession = typeof opts.abortSession === "function"
    ? opts.abortSession
    : () => Promise.resolve({ status: "unavailable" });
  const resolveTemplateHint = typeof opts.resolveTemplateHint === "function"
    ? opts.resolveTemplateHint
    : () => null;

  let launchClaim      = null;
  let activeRun      = null;
  let launchResolution      = null;

  function publicRun(run     ) {
    if (!run) return null;
    return {
      runId: run.runId,
      taskId: run.taskId,
      versionId: run.versionId,
      sessionKey: run.sessionKey,
      executor: copyExecutor(run.executor),
      context: run.context,
      startedAt: run.startedAt,
      state: run.state,
      toolNames: [...run.toolNames],
      approvals: run.approvals.map((approval     ) => ({
        toolName: approval.toolName,
        outcome: approval.outcome,
      })),
      surfaceIds: [...run.surfaceIds],
      delivery: run.delivery,
      ...(Number.isSafeInteger(run.firstRenderAt)
        ? { firstRenderAt: run.firstRenderAt }
        : {}),
      ...(run.feed ? { feed: { ...run.feed, keys: [...run.feed.keys] }, fedCount: run.fedCount } : {}),
      ...(typeof run.by === "string" ? { by: run.by } : {}),
      ...(Number.isSafeInteger(run.endedAt) ? { endedAt: run.endedAt } : {}),
      ...(typeof run.endedReason === "string" ? { endedReason: run.endedReason } : {}),
    };
  }

  function settleLaunch(result     ) {
    const pending = launchResolution;
    launchResolution = null;
    if (pending) pending.resolve(result);
  }

  function bestEffortAbort(sessionKey     ) {
    const key = normalizeSessionKey(sessionKey);
    if (!key) return;
    try {
      Promise.resolve(abortSession(key)).catch(() => {});
    } catch (_) {

    }
  }

  function endRun(reason     , options      = {}) {
    const run = activeRun;
    if (!run || run.state === LIVEUI_TASK_RUN_STATES.ended) return null;
    run.state = LIVEUI_TASK_RUN_STATES.ended;
    run.endedReason = LIVEUI_TASK_RUN_END_REASONS.includes(reason) ? reason : "session_reset";
    run.endedAt = now();
    activeRun = null;
    launchClaim = null;
    if (options.abort === true) bestEffortAbort(run.sessionKey);
    if (launchResolution) {
      settleLaunch(rejected(run.taskId, options.code || reason || "task_launch_failed"));
    }
    const ended = publicRun(run);
    try { onRunEnded(ended); } catch (_) {

    }
    return ended;
  }

  function failClaim(taskId     , code     ) {
    launchClaim = null;
    return rejected(taskId, code);
  }

  async function launchTask(params      = {}) {
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    const clientId = typeof params.clientId === "string" ? params.clientId : "";
    if (params.origin !== "glasses" || !clientId) {
      return rejected(taskId, "task_launch_origin_invalid");
    }
    if (launchClaim || activeRun) return rejected(taskId, "task_run_busy");

    const loaded = opts.loadTask(taskId);
    const version = approvedVersionFromLoad(loaded);
    if (!version) return rejected(taskId, "task_not_ready");
    let firstMessage = taskRunStartMessage(version, loaded.task.settingValues);
    const preferredTemplateId = Object.prototype.hasOwnProperty.call(
      version,
      "preferredTemplateId",
    )
      ? typeof version.preferredTemplateId === "string"
        ? version.preferredTemplateId
        : null
      : loaded && loaded.task && typeof loaded.task.preferredTemplateId === "string"
        ? loaded.task.preferredTemplateId
        : null;
    const preferredTemplateName = typeof version.preferredTemplateName === "string"
      ? version.preferredTemplateName
      : null;
    if (preferredTemplateId && preferredTemplateName) {
      let hint = null;
      try { hint = resolveTemplateHint(preferredTemplateId); } catch (_) { hint = null; }
      if (
        hint &&
        hint.templateId === preferredTemplateId &&
        typeof hint.name === "string"
      ) {
        firstMessage += `\n\nPreferred Template (optional visual hint, not a required output): "${preferredTemplateName}" (templateId: ${hint.templateId}). You may render it through the Template library, replace it with any other valid LiveUI surface, or ignore it.`;
      }
    }
    if (!["isolated", "current_session"].includes(version.context)) {
      return rejected(taskId, "task_not_ready");
    }
    const feed = feedFromParams(params.feed === undefined && typeof opts.resolvePresentationFeed === "function"
      ? opts.resolvePresentationFeed({ taskId, clientId, version }) : params.feed);
    if (params.feed !== undefined && !feed) return rejected(taskId, "card_not_bound");
    if (feed) firstMessage += `\n\n${taskFeedRunMessage(feed)}`;

    const claim = { taskId, clientId, cancelled: false };
    launchClaim = claim;

    let executor;
    let sessionKey = "";
    if (version.context === "current_session") {
      if (!resolveCurrentSession) {
        return failClaim(taskId, "executor_unavailable");
      }
      let current;
      try {
        current = await resolveCurrentSession();
      } catch (_) {
        return failClaim(taskId, claim.cancelled ? "task_cancelled" : "executor_unavailable");
      }
      executor = {
        host,
        agentId: current && typeof current.agentId === "string" ? current.agentId.trim() : "",
      };
      sessionKey = normalizeSessionKey(current && current.sessionKey);
    } else {
      let resolution;
      try {
        resolution = await opts.resolveExecutor(copyExecutor(version.executor));
      } catch (_) {
        return failClaim(taskId, claim.cancelled ? "task_cancelled" : "executor_unavailable");
      }
      if (claim.cancelled) return failClaim(taskId, "task_cancelled");
      if (resolution && resolution.state === "needs_setup") {
        return failClaim(taskId, "executor_needs_setup");
      }
      if (!resolution || resolution.state !== "ready") {
        return failClaim(taskId, claim.cancelled ? "task_cancelled" : "executor_unavailable");
      }
      executor = resolution.executor;
      if (
        !executor ||
        executor.host !== host ||
        typeof executor.agentId !== "string" ||
        !executor.agentId.trim()
      ) {
        return failClaim(taskId, claim.cancelled ? "task_cancelled" : "executor_unavailable");
      }
      let created;
      try {
        created = await opts.createSession(copyExecutor(executor));
      } catch (_) {
        return failClaim(taskId, claim.cancelled ? "task_cancelled" : "executor_unavailable");
      }
      sessionKey = normalizeSessionKey(created && created.sessionKey);
    }
    if (claim.cancelled) {
      launchClaim = null;
      if (version.context === "isolated") bestEffortAbort(sessionKey);
      return rejected(taskId, "task_cancelled");
    }
    if (
      !executor ||
      executor.host !== host ||
      typeof executor.agentId !== "string" ||
      !executor.agentId.trim() ||
      (version.context === "isolated" && !sessionKey)
    ) {
      return failClaim(taskId, claim.cancelled ? "task_cancelled" : "executor_unavailable");
    }

    const run      = {
      runId: newRunId(),
      taskId,
      versionId: version.versionId,
      sessionKey,
      executor: copyExecutor(executor),
      context: version.context,
      startedAt: now(),
      state: LIVEUI_TASK_RUN_STATES.starting,
      toolNames: [],
      approvals: [],
      surfaceIds: [],
      delivery: "none",
      ...(feed ? { feed, fedCount: 0 } : {}),

      ...(feed && ["card", "open", "agent"].includes(params.by) ? { by: params.by } : {}),
    };
    activeRun = run;
    launchClaim = null;
    try { onRunStarted(publicRun(run)); } catch (_) {

    }

    const resultPromise = new Promise((resolve) => {
      launchResolution = { resolve, runId: run.runId };
    });

    try {
      const sendResult = await opts.sendUserMessage({
        runId: run.runId,
        sessionKey: sessionKey || undefined,
        text: firstMessage,
        executor: copyExecutor(executor),
        onSessionResolved(resolvedSessionKey     ) {
          const resolved = normalizeSessionKey(resolvedSessionKey);
          if (resolved && activeRun === run && !run.sessionKey) run.sessionKey = resolved;
        },
      });
      if (!run.sessionKey) {
        run.sessionKey = normalizeSessionKey(sendResult && sendResult.sessionKey);
      }
      if (!run.sessionKey) {
        endRun("launch_failed", { code: "task_launch_failed" });
      }
    } catch (_) {
      endRun("launch_failed", { code: "task_launch_failed" });
    }
    return resultPromise;
  }

  function observeFirstRender(params      = {}) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (
      !run ||
      run.state !== LIVEUI_TASK_RUN_STATES.starting ||
      !sessionKey ||
      sessionKey !== run.sessionKey
    ) return false;
    const surfaceId = typeof params.surfaceId === "string" ? params.surfaceId.trim() : "";
    if (surfaceId && !run.surfaceIds.includes(surfaceId)) run.surfaceIds.push(surfaceId);
    run.state = LIVEUI_TASK_RUN_STATES.running;
    run.firstRenderAt = Number.isSafeInteger(params.at) ? params.at : now();
    settleLaunch({ itemType: "task", itemId: run.taskId, status: "accepted" });
    return true;
  }

  function observeSurfaceRender(params      = {}) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const surfaceId = typeof params.surfaceId === "string" ? params.surfaceId.trim() : "";
    if (!run || !sessionKey || sessionKey !== run.sessionKey || !surfaceId) return false;
    if (!run.surfaceIds.includes(surfaceId)) run.surfaceIds.push(surfaceId);
    return true;
  }

  function observeToolUse(params      = {}) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
    if (!run || !sessionKey || sessionKey !== run.sessionKey || !toolName) return false;
    if (!run.toolNames.includes(toolName)) run.toolNames.push(toolName);
    return true;
  }

  function observeApproval(params      = {}) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const toolName = typeof params.toolName === "string" ? params.toolName.trim() : "";
    const outcome = typeof params.outcome === "string" ? params.outcome.trim() : "";
    if (!run || !sessionKey || sessionKey !== run.sessionKey || !toolName || !outcome) return false;
    run.approvals.push({ toolName, outcome });
    return true;
  }

  function observeSurfaceDelivery(params      = {}) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(params.sessionKey);
    const surfaceId = typeof params.surfaceId === "string" ? params.surfaceId.trim() : "";
    const delivery = typeof params.delivery === "string" ? params.delivery.trim() : "";
    if (!run || !sessionKey || sessionKey !== run.sessionKey || !surfaceId || !delivery) return false;
    if (!run.surfaceIds.includes(surfaceId)) run.surfaceIds.push(surfaceId);
    try {
      if (run.delivery === "none" || compareRungs(delivery, run.delivery) > 0) {
        run.delivery = delivery;
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  function observeRenderAttempt(params     ) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(
      params && typeof params === "object" ? params.sessionKey : params,
    );
    if (
      !run ||
      (run.state !== LIVEUI_TASK_RUN_STATES.starting && run.state !== LIVEUI_TASK_RUN_STATES.running) ||
      sessionKey !== run.sessionKey
    ) return false;
    const surfaceId = params && typeof params === "object" && typeof params.surfaceId === "string"
      ? params.surfaceId.trim()
      : "";
    if (surfaceId && !run.surfaceIds.includes(surfaceId)) run.surfaceIds.push(surfaceId);
    run.renderAttempted = true;
    if (surfaceId) observeSurfaceDelivery({ sessionKey, surfaceId, delivery: "send_attempted" });
    return true;
  }

  function observeFeed(params      = {}) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!run || !run.feed || !sessionKey || sessionKey !== run.sessionKey) return false;
    run.fedCount += 1;
    if (run.state === LIVEUI_TASK_RUN_STATES.starting) {
      run.state = LIVEUI_TASK_RUN_STATES.running;
      run.firstRenderAt = now();
      settleLaunch({ itemType: "task", itemId: run.taskId, status: "accepted" });
    }
    return true;
  }

  function observeTurnIdle(sessionKey     , options      = {}) {
    const run = activeRun;

    if (
      run &&
      run.feed &&
      run.state !== LIVEUI_TASK_RUN_STATES.ended &&
      normalizeSessionKey(sessionKey) === run.sessionKey &&
      !run.renderAttempted
    ) {
      if (run.fedCount > 0) endRun("fed");
      else if (options && options.failed === true) endRun("launch_failed", { code: "task_launch_failed" });
      else endRun("no_ui", { code: "no_data" });
      return true;
    }
    if (
      !run ||
      run.state !== LIVEUI_TASK_RUN_STATES.starting ||
      normalizeSessionKey(sessionKey) !== run.sessionKey
    ) return false;

    if (run.renderAttempted) return true;

    if (options && options.failed === true) {
      endRun("launch_failed", { code: "task_launch_failed" });
      return true;
    }
    endRun("no_ui", { code: "no_ui" });
    return true;
  }

  function observeRenderFailure(sessionKey     ) {
    const run = activeRun;
    if (
      !run ||
      run.state !== LIVEUI_TASK_RUN_STATES.starting ||
      normalizeSessionKey(sessionKey) !== run.sessionKey
    ) return false;
    endRun("render_failed", { code: "render_failed" });
    return true;
  }

  function observeSurfaceRenderFailure(params      = {}) {
    const run = activeRun;
    if (!run || normalizeSessionKey(params.sessionKey) !== run.sessionKey ||
        !run.surfaceIds.includes(params.surfaceId)) return false;
    endRun("render_failed", { code: "render_failed" });
    return true;
  }

  function observeSurfaceOutcome(params      = {}) {
    const run = activeRun;
    if (!run || normalizeSessionKey(params.sessionKey) !== run.sessionKey) return false;
    const result = params && params.outcome && typeof params.outcome.result === "string"
      ? params.outcome.result.trim().toLowerCase()
      : "";
    if (result !== "dismissed" && result !== "checklist_dismissed") return false;
    endRun("dismissed", { abort: true, code: "task_cancelled" });
    return true;
  }

  function observeSessionEnd(params      = {}) {
    const run = activeRun;
    const sessionKey = normalizeSessionKey(params.sessionKey);
    if (!run || (sessionKey && sessionKey !== run.sessionKey)) return false;
    const reason = typeof params.reason === "string" && params.reason
      ? params.reason
      : "session_reset";
    const code = reason === "glasses_disconnected" ? "task_launch_failed" : "task_cancelled";
    endRun(reason, { code });
    return true;
  }

  function cancelTaskLaunch(params      = {}) {
    const run = activeRun;
    const taskId = typeof params.taskId === "string" ? params.taskId : "";
    const clientId = typeof params.clientId === "string" ? params.clientId : "";
    if (!clientId) return false;
    if (!run && launchClaim && launchClaim.taskId === taskId && launchClaim.clientId === clientId) {
      launchClaim.cancelled = true;
      return true;
    }
    if (!run || run.taskId !== taskId) return false;
    endRun("cancelled", { abort: true, code: "task_cancelled" });
    return true;
  }

  function observeHostLoss() {
    if (!activeRun) return false;
    endRun("host_lost", { code: "executor_unavailable" });
    return true;
  }

  return {
    launchTask,
    cancelTaskLaunch,
    observeRenderAttempt,
    observeFirstRender,
    observeFeed,
    observeSurfaceRender,
    observeSurfaceDelivery,
    observeToolUse,
    observeApproval,
    observeTurnIdle,
    observeRenderFailure,
    observeSurfaceRenderFailure,
    observeSurfaceOutcome,
    observeSessionEnd,
    observeHostLoss,
    activeRun() {
      return publicRun(activeRun);
    },
    isBusy() {
      return !!(launchClaim || activeRun);
    },
  };
}

module.exports = { LIVEUI_TASK_RUN_STATES, LIVEUI_TASK_RUN_END_REASONS, taskFeedRunMessage, projectLiveuiTaskRunForPhone, taskRunStartMessage, createLiveuiTaskRunController };
