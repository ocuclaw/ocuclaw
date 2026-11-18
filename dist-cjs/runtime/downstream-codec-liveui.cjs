const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { programCardKitLevelValue } = require("../tools/program-card-kit-check.cjs");
const { isUnshownLine } = require("../tools/program-card-unshown.cjs");

function formatLiveuiLibrary(items     ) {
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiLibrarySnapshot,
    items: Array.isArray(items) ? items : [],
  });
}

function formatLiveuiLibraryOpenResult(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiLibraryOpenResult,
    itemType: typeof payload.itemType === "string" ? payload.itemType : "",
    itemId: typeof payload.itemId === "string" ? payload.itemId : "",
    status,
    ...(status === "rejected" && code ? { code } : {}),
  });
}

function revisionNumber(value     ) {
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function formatProgramCardSaveResult(payload      = {}) {
  const status = payload.status === "saved" ? "saved" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  const revision = status === "saved" ? revisionNumber(payload.revision) : null;
  const dropped = status === "saved" && Array.isArray(payload.dropped)
    ? payload.dropped.filter((value     ) => revisionNumber(value) !== null)
    : [];
  return JSON.stringify({
    type: APP_PROTOCOL.programCardSaveResult,
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    status,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    name: typeof payload.name === "string" ? payload.name : "",

    ...(revision !== null ? { revision } : {}),
    ...(status === "saved" && typeof payload.sourceHash === "string" && /^sha256:[a-f0-9]{64}$/.test(payload.sourceHash)
      ? { sourceHash: payload.sourceHash } : {}),
    ...(dropped.length ? { dropped } : {}),
    ...(status === "rejected" ? { code: code || "save_failed" } : {}),
  });
}

function revisionRow(row     ) {
  const number = row && typeof row === "object" ? revisionNumber(row.number) : null;
  if (number === null) return null;
  return {
    number,
    name: typeof row.name === "string" ? row.name : "",
    savedAtMs: Number.isSafeInteger(row.savedAtMs) ? row.savedAtMs : 0,
    ...(typeof row.by === "string" && row.by ? { by: row.by } : {}),
    ...(typeof row.note === "string" && row.note ? { note: row.note } : {}),
    current: row.current === true,

    ...(typeof row.picture?.png === "string" && row.picture.png ? { picture: { png: row.picture.png } } : {}),
    ...(Array.isArray(row.tests) && row.tests.length ? {

      tests: row.tests.map((test     ) => ({ requirement: test.requirement, verdict: test.verdict,
        ...(test.verdict === "wearer_check" && isUnshownLine(test.requirement) ? { cant: true } : {}) })),
      ...(Number.isSafeInteger(row.testedAtMs) ? { testedAtMs: row.testedAtMs } : {}),
    } : {}),

    ...(row.fixed && typeof row.fixed === "object" && typeof row.fixed.task === "string" && typeof row.fixed.key === "string" &&
      typeof row.fixed.change === "string" ? { fixed: { task: row.fixed.task, key: row.fixed.key,
        ...(typeof row.fixed.label === "string" && row.fixed.label ? { label: row.fixed.label } : {}), change: row.fixed.change } } : {}),

    ...(Number.isSafeInteger(row.parts) && row.parts >= 1 && row.parts <= 9 ? { parts: row.parts } : {}),

    ...(row.framed === true ? { framed: true } : {}),
    ...(row.framed === true && typeof row.frameStyle === "string" && row.frameStyle ? { frameStyle: row.frameStyle.slice(0, 120) } : {}),

    ...(row.framed === true && typeof row.framePng === "string" && /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(row.framePng) ? { framePng: row.framePng } : {}),
  };
}

function formatProgramCardSource(payload      = {}) {
  const accepted = payload.status === "accepted";
  return JSON.stringify({
    type: APP_PROTOCOL.programCardSource,
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    appId: typeof payload.appId === "string" ? payload.appId : "",
    status: accepted ? "accepted" : "rejected",
    ...(accepted ? { name: payload.name, revision: payload.revision, sourceHash: payload.sourceHash, card: payload.card }
      : { code: payload.code || "source_unavailable" }),
  });
}

function formatProgramCardRevisions(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.programCardRevisions,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    status,
    ...(status === "accepted"
      ? {
          name: typeof payload.name === "string" ? payload.name : "",
          current: revisionNumber(payload.current) ?? 1,
          revisions: (Array.isArray(payload.revisions) ? payload.revisions : [])
            .map(revisionRow)
            .filter(Boolean),

          ...(typeof payload.game === "boolean" ? { game: payload.game } : {}),
          ...(payload.frameLane === "drawing" ? { frameLane: "drawing" } : {}),

          ...(typeof payload.frameBlocked === "string" && /^frame_[a-z_]{1,40}$/.test(payload.frameBlocked)
            ? { frameBlocked: payload.frameBlocked } : {}),
        }
      : { code: code || "app_not_found" }),
  });
}

function formatProgramCardRevisionResult(payload      = {}) {

  const status = ["restored", "deleted", "saved", "renamed", "drawing"].includes(payload.status) ? payload.status : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  const number = revisionNumber(payload.number);
  return JSON.stringify({
    type: APP_PROTOCOL.programCardRevisionResult,
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    action: typeof payload.action === "string" ? payload.action : "",
    status,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    ...(number !== null ? { number } : {}),
    ...(typeof payload.name === "string" && payload.name ? { name: payload.name } : {}),
    ...(typeof payload.newAppId === "string" && payload.newAppId ? { newAppId: payload.newAppId } : {}),
    ...(status === "rejected" ? { code: code || "revision_failed" } : {}),
  });
}

const FRAME_LANES = new Set(["drawing", "added", "none"]);

function formatProgramCardFrame(payload      = {}) {
  const number = revisionNumber(payload.number);
  const lane = FRAME_LANES.has(payload.lane) ? payload.lane : "none";
  return JSON.stringify({
    type: APP_PROTOCOL.programCardFrame,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    lane,
    ...(lane === "added" && number !== null ? { number } : {}),
    ...(lane === "none" && typeof payload.code === "string" && payload.code ? { code: payload.code.slice(0, 64) } : {}),
    ...(typeof payload.style === "string" && payload.style ? { style: payload.style.slice(0, 120) } : {}),

    ...(lane !== "none" && typeof payload.idea === "string" && payload.idea ? { idea: payload.idea.slice(0, 120) } : {}),
  });
}

function slotRow(row     ) {
  if (!row || typeof row !== "object") return null;
  const slot = Number.isSafeInteger(row.slot) && row.slot >= 1 && row.slot <= 3 ? row.slot : null;
  if (slot === null || !Number.isSafeInteger(row.savedAtMs)) return null;
  return {
    slot,
    ...(typeof row.label === "string" && row.label ? { label: row.label } : {}),
    ...(revisionNumber(row.revision) !== null ? { revision: row.revision } : {}),
    savedAtMs: row.savedAtMs,
  };
}

function formatProgramCardSlots(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.programCardSlots,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    status,
    ...(status === "accepted"
      ? { slots: (Array.isArray(payload.slots) ? payload.slots : []).map(slotRow).filter(Boolean) }
      : { code: code || "app_not_found" }),
  });
}

function formatProgramCardSlotResult(payload      = {}) {
  const status = ["saved", "accepted", "deleted"].includes(payload.status) ? payload.status : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  const row = status === "rejected" ? null : slotRow(payload);
  const slot = Number.isSafeInteger(payload.slot) && payload.slot >= 1 && payload.slot <= 3 ? payload.slot : null;
  return JSON.stringify({
    type: APP_PROTOCOL.programCardSlotResult,
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    action: typeof payload.action === "string" ? payload.action : "",
    status,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    ...(slot !== null ? { slot } : {}),
    ...(row ? row : {}),
    ...(status === "accepted" && payload.state !== undefined
      ? {
          state: payload.state,
          ...(typeof payload.sourceHash === "string" ? { sourceHash: payload.sourceHash } : {}),
          migrate: payload.migrate === true,
        }
      : {}),
    ...(status === "rejected" ? { code: code || "slot_failed" } : {}),
  });
}

function formatProgramCardCheckpointResult(payload      = {}) {
  const status = ["saved", "stale", "rejected"].includes(payload.status) ? payload.status : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.programCardCheckpointResult,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    seq: Number.isSafeInteger(payload.seq) ? payload.seq : -1,
    status,
    ...(status === "rejected" ? { code: code || "save_failed" } : {}),
  });
}

function formatProgramCardOpen(payload      = {}) {
  return JSON.stringify({
    type: APP_PROTOCOL.programCardOpen,
    appId: payload.appId,
    name: payload.name,
    card: payload.card,
    state: payload.state === undefined ? null : payload.state,
    seq: payload.seq,
    savedAtMs: payload.savedAtMs,
    requestedAtMs: payload.requestedAtMs,
    ...(typeof payload.sourceHash === "string" ? { sourceHash: payload.sourceHash } : {}),
    ...(revisionNumber(payload.revision) !== null ? { revision: payload.revision } : {}),

    ...(payload.fresh === true ? { fresh: true } : {}),

    ...(programCardKitLevelValue(payload.kit?.level) !== null ? { kit: { level: payload.kit.level } } : {}),
  });
}

function formatProgramCardReview(payload      = {}) {
  return JSON.stringify({
    type: APP_PROTOCOL.programCardReview,
    appId: typeof payload.appId === "string" ? payload.appId : "",
    available: payload.available === true,
    ...(payload.retryAvailable === true ? { retryAvailable: true } : {}),
    ...(Number.isSafeInteger(payload.retryAtMs) && Number.isSafeInteger(payload.serverNowMs)
      ? { retryAtMs: payload.retryAtMs, serverNowMs: payload.serverNowMs } : {}),
    review: payload.review && typeof payload.review === "object" ? payload.review : null,
    ...(typeof payload.requestId === "string" && payload.requestId ? { requestId: payload.requestId } : {}),
    ...(typeof payload.code === "string" && payload.code ? { code: payload.code } : {}),

    ...(typeof payload.showcase === "string" && payload.showcase ? { showcase: payload.showcase } : {}),

    ...(payload.lookVersion === 1 ? {
      lookVersion: 1,
      ...(typeof payload.source === "string" ? { source: payload.source } : {}),
      ...(typeof payload.sourceDigest === "string" ? { sourceDigest: payload.sourceDigest } : {}),
      ...(Number.isSafeInteger(payload.revision) ? { revision: payload.revision } : {}),
      ...(payload.state !== undefined ? { state: payload.state } : {}),
      ...(payload.asks ? { asks: payload.asks } : {}),
    } : {}),
  });
}

function formatProgramCardReviewApplyResult(payload      = {}) {
  const status = ["candidate", "saved", "no_gain", "held"].includes(payload.status) ? payload.status : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.programCardReviewApplyResult,
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    appId: typeof payload.appId === "string" ? payload.appId : "",
    reviewId: typeof payload.reviewId === "string" ? payload.reviewId : "",
    ideaId: typeof payload.ideaId === "string" ? payload.ideaId : "",
    status,
    ...(status === "candidate"
      ? {
          candidateId: payload.candidateId,
          attempt: payload.attempt,
          name: payload.name,
          card: payload.card,
          freshState: payload.freshState === true,
          ...(payload.freshState === true ? {} : { state: payload.state === undefined ? null : payload.state }),

          reason: ["refit", "fix"].includes(payload.reason) ? payload.reason : null,
          ...(payload.diff && Array.isArray(payload.diff.lines) ? { diff: payload.diff } : {}),
        }
      : {}),
    ...(status === "saved" ? { revision: revisionNumber(payload.revision) ?? 1 } : {}),
    ...(payload.compare && typeof payload.compare === "object" ? { compare: payload.compare } : {}),
    ...(status === "no_gain" ? { candidateId: payload.candidateId, metric: payload.metric, before: payload.before, after: payload.after } : {}),
    ...(status === "held" ? { candidateId: payload.candidateId, reason: payload.reason } : {}),
    ...(status === "rejected" ? { code: code || "apply_failed" } : {}),
    ...(status === "rejected" && typeof payload.error === "string" && payload.error
      ? { error: payload.error.slice(0, 300) }
      : {}),
  });
}

function formatProgramCardSaveRequest(payload      = {}) {
  return JSON.stringify({
    type: APP_PROTOCOL.programCardSaveRequest,
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    ...(typeof payload.name === "string" && payload.name.trim() ? { name: payload.name.trim() } : {}),

    ...(["revision", "replace", "new"].includes(payload.mode) ? { mode: payload.mode } : {}),
  });
}

function normalizeLiveuiTaskRunning(value     ) {
  if (!value || typeof value !== "object") return null;
  const runId = typeof value.runId === "string" ? value.runId : "";
  if (!runId) return null;
  return {
    since: Number.isSafeInteger(value.since) ? value.since : 0,
    executor: typeof value.executor === "string" ? value.executor : "",
    runId,
  };
}

function formatLiveuiTasks(payload      = {}) {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTasksSnapshot,
    tasks: tasks.map((task     ) =>
      task && typeof task === "object"
        ? { ...task, running: normalizeLiveuiTaskRunning(task.running) }
        : task,
    ),
    templates: Array.isArray(payload.templates) ? payload.templates : [],
    invalid: Array.isArray(payload.invalid) ? payload.invalid : [],
    organization: payload.organization && typeof payload.organization === "object"
      ? payload.organization
      : { schemaVersion: 1, order: [], hidden: [], digest: "" },
    ...(typeof payload.organizationInvalid === "string" && payload.organizationInvalid
      ? { organizationInvalid: payload.organizationInvalid }
      : {}),
  });
}

function formatLiveuiTaskRuns(taskId     , records     ) {
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTaskRunsSnapshot,
    taskId: typeof taskId === "string" ? taskId : "",
    records: Array.isArray(records) ? records : [],
  });
}

function formatLiveuiTaskReviewAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTaskReviewAck,
    taskId: typeof payload.taskId === "string" ? payload.taskId : "",
    action: typeof payload.action === "string" ? payload.action : "",
    status,
    ...(status === "rejected" && code ? { code } : {}),
    ...(status === "rejected" && typeof payload.message === "string" && payload.message
      ? { message: payload.message }
      : {}),
    ...(payload.task && typeof payload.task === "object" ? { task: payload.task } : {}),
  });
}

function formatLiveuiTaskExecutors(payload      = {}) {
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTaskExecutorsSnapshot,
    thisHost: payload.thisHost === "hermes" ? "hermes" : "openclaw",
    executors: Array.isArray(payload.executors) ? payload.executors : [],
  });
}

function formatLiveuiTaskExecutorAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTaskExecutorAck,
    taskId: typeof payload.taskId === "string" ? payload.taskId : "",
    status,
    ...(status === "rejected" && code ? { code } : {}),
  });
}

function formatLiveuiTaskPreferredTemplateAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTaskPreferredTemplateAck,
    taskId: typeof payload.taskId === "string" ? payload.taskId : "",
    status,
    ...(status === "rejected" && code ? { code } : {}),
    ...(payload.task && typeof payload.task === "object" ? { task: payload.task } : {}),
  });
}

function formatLiveuiTaskContextAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTaskContextAck,
    taskId: typeof payload.taskId === "string" ? payload.taskId : "",
    status,
    ...(status === "rejected" && code ? { code } : {}),
  });
}

function formatLiveuiPrefs(payload      = {}) {
  const prefs = payload && typeof payload === "object" ? payload : {};
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiPrefsSnapshot,
    enabled: prefs.enabled !== false,
    defaultContext: prefs.defaultContext === "current_session" ? "current_session" : "isolated",
    defaultExecutor: typeof prefs.defaultExecutor === "string" && prefs.defaultExecutor
      ? prefs.defaultExecutor
      : null,
    pauseApps: prefs.pauseApps === true,

    titleIcons: prefs.titleIcons !== false,

    videoSpeed: prefs.videoSpeed !== false,

    videoSize: typeof prefs.videoSize === "number" ? prefs.videoSize : 288,

    videoSubtitles: prefs.videoSubtitles === true,
    ...(typeof prefs.prefsInvalid === "string" && prefs.prefsInvalid
      ? { prefsInvalid: prefs.prefsInvalid }
      : {}),
  });
}

function formatLiveuiPrefsAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiPrefsAck,
    status,
    ...(status === "rejected" && code ? { code } : {}),
  });
}

function formatLiveuiGrantsSnapshot(payload      = {}) {
  const snapshot = payload && typeof payload === "object" ? payload : {};
  const rows = (value     , project     ) =>
    (Array.isArray(value) ? value : []).map((entry     ) => project(
      entry && typeof entry === "object" ? entry : {},
    ));
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiGrantsSnapshot,
    httpHostPolicy: snapshot.httpHostPolicy === "owner-grants"
      ? "owner-grants"
      : "operator-only",
    digest: typeof snapshot.digest === "string" ? snapshot.digest : null,
    ...(typeof snapshot.grantsInvalid === "string" && snapshot.grantsInvalid
      ? { grantsInvalid: snapshot.grantsInvalid }
      : {}),
    pending: rows(snapshot.pending, (entry     ) => ({
      host: typeof entry.host === "string" ? entry.host : "",
      method: typeof entry.method === "string" ? entry.method : "",
      hasHeaders: entry.hasHeaders === true,
      hasBody: entry.hasBody === true,
      punycode: entry.punycode === true,
      unicodeHost: typeof entry.unicodeHost === "string" ? entry.unicodeHost : null,
      requestedAt: typeof entry.requestedAt === "string" ? entry.requestedAt : "",
    })),
    granted: rows(snapshot.granted, (entry     ) => ({
      host: typeof entry.host === "string" ? entry.host : "",
      grantedAt: typeof entry.grantedAt === "string" ? entry.grantedAt : "",
    })),
    denied: rows(snapshot.denied, (entry     ) => ({
      host: typeof entry.host === "string" ? entry.host : "",
      deniedAt: typeof entry.deniedAt === "string" ? entry.deniedAt : "",
    })),
  });
}

function formatLiveuiGrantsAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiGrantsAck,
    status,
    action: typeof payload.action === "string" ? payload.action : "",
    host: typeof payload.host === "string" ? payload.host : "",
    ...(status === "rejected" && code ? { code } : {}),
    ...(status === "accepted" && Array.isArray(payload.clearedSessionKeys)
      ? { clearedSessionKeys: payload.clearedSessionKeys.filter(
          (sessionKey     ) => typeof sessionKey === "string" && sessionKey,
        ) }
      : {}),
  });
}

function formatLiveuiStatus(payload      = {}) {
  const status = payload && typeof payload === "object" ? payload : {};
  const asInt = (value     ) => (Number.isFinite(value) ? Math.floor(value) : 0);
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiStatusSnapshot,
    host: status.host === "hermes" ? "hermes" : "openclaw",
    refreshEnabled: status.refreshEnabled !== false,
    httpEnabled: status.httpEnabled === true,
    httpHostPolicy: status.httpHostPolicy === "owner-grants"
      ? "owner-grants"
      : "operator-only",
    allowedDomains: asInt(status.allowedDomains),
    ownerGrants: asInt(status.ownerGrants),
    llmEnabled: status.llmEnabled === true,
    allowAgentModelOverride: status.allowAgentModelOverride === true,
    tickModel: typeof status.tickModel === "string" && status.tickModel ? status.tickModel : null,
    tickBackend: typeof status.tickBackend === "string" && status.tickBackend ? status.tickBackend : null,
    tickAuth: status.tickAuth === "missing_key" || status.tickAuth === "no_backend"
      ? status.tickAuth
      : "ok",
    ...(typeof status.grantsInvalid === "string" && status.grantsInvalid
      ? { grantsInvalid: status.grantsInvalid }
      : {}),
    surfaces: asInt(status.surfaces),
    maxSurfaces: Number.isFinite(status.maxSurfaces) ? Math.floor(status.maxSurfaces) : 1,
    stageGraceMs: asInt(status.stageGraceMs),
    approvalHudSupported: status.approvalHudSupported !== false,
  });
}

function formatLiveuiTaskSettingsAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiTaskSettingsAck,
    taskId: typeof payload.taskId === "string" ? payload.taskId : "",
    status,
    ...(status === "rejected" && code ? { code } : {}),
    ...(status === "rejected" && Array.isArray(payload.invalid)
      ? { invalid: payload.invalid.map((entry     ) => ({
          key: entry && typeof entry.key === "string" ? entry.key : "",
          code: entry && typeof entry.code === "string" ? entry.code : "setting_value_invalid",
        })) }
      : {}),
    ...(payload.task && typeof payload.task === "object" ? { task: payload.task } : {}),
  });
}

function formatLiveuiLibraryOrganizeAck(payload      = {}) {
  const status = payload.status === "accepted" ? "accepted" : "rejected";
  const code = typeof payload.code === "string" && payload.code ? payload.code : null;
  const message = typeof payload.message === "string" && payload.message ? payload.message : null;
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiLibraryOrganizeAck,
    action: typeof payload.action === "string" ? payload.action : "",
    status,
    ...(status === "rejected" && code ? { code } : {}),
    ...(status === "rejected" && message ? { message } : {}),
    ...(status === "accepted" && Array.isArray(payload.clearedPreferredTemplateTaskIds)
      ? { clearedPreferredTemplateTaskIds: payload.clearedPreferredTemplateTaskIds }
      : {}),
  });
}

const LIVEUI_VIDEO_ROUTE_STATES = new Set([
  "no_tailscale_here",
  "phone_not_on_tailnet",
  "not_offered",
  "not_approved",
  "ready",
  "on",
]);

function formatLiveuiVideoRouteState(payload      = {}) {
  const p = payload && typeof payload === "object" ? payload : {};
  return JSON.stringify({
    type: APP_PROTOCOL.liveuiVideoRouteState,
    state: LIVEUI_VIDEO_ROUTE_STATES.has(p.state) ? p.state : "no_tailscale_here",
    phone: typeof p.phone === "string" && p.phone ? p.phone.slice(0, 80) : null,
    detail: typeof p.detail === "string" && p.detail ? p.detail.slice(0, 240) : null,
  });
}

module.exports = { formatLiveuiVideoRouteState, formatLiveuiLibrary, formatLiveuiLibraryOpenResult, formatProgramCardSaveResult, formatProgramCardCheckpointResult, formatProgramCardOpen, formatProgramCardSaveRequest, formatProgramCardSource, formatProgramCardRevisions, formatProgramCardRevisionResult, formatProgramCardFrame, formatProgramCardSlots, formatProgramCardSlotResult, formatProgramCardReview, formatProgramCardReviewApplyResult, formatLiveuiTasks, formatLiveuiTaskRuns, formatLiveuiTaskReviewAck, formatLiveuiTaskExecutors, formatLiveuiTaskExecutorAck, formatLiveuiTaskPreferredTemplateAck, formatLiveuiTaskContextAck, formatLiveuiPrefs, formatLiveuiPrefsAck, formatLiveuiGrantsSnapshot, formatLiveuiGrantsAck, formatLiveuiStatus, formatLiveuiTaskSettingsAck, formatLiveuiLibraryOrganizeAck };
