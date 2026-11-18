const { displayOptionLabel } = require("../domain/question-option-label.cjs");

const OPENCLAW_WAITING_GRACE_MS = 15_000;

const FALLBACK_TIMEOUT_MS = 30 * 60_000;

const EXPIRY_SLACK_MS = 5_000;
const PREVIEW_MAX_CHARS = 240;
const EXPLAIN_COMMAND_MAX_CHARS = 2000;
const EXPLAIN_DESCRIPTION_MAX_CHARS = 500;
const ANSWER_TEXT_MAX_CHARS = 4000;

const OPENCLAW_WAITING_LOCAL_SURFACE = "webchat";
const OPENCLAW_WAITING_LOCAL_SURFACES = [OPENCLAW_WAITING_LOCAL_SURFACE];
const SURFACE_NAME_RE = /^[a-z0-9_-]{1,32}$/;

const LOCAL_TURN_SOURCES = new Set(["", "webchat", "internal", "tui", "web", "control-ui"]);
const PEER_KINDS = new Set(["channel", "group", "direct", "dm"]);
const AGENT_SCOPED_KEY_RE = /^agent:([^:]+):(.+)$/i;

const DECISION_TO_CHOICE                         = {
  "allow-once": "once",
  "allow-always": "always",
  deny: "deny",
};
const CHOICE_TO_DECISION                         = {
  once: "allow-once",
  always: "allow-always",
  deny: "deny",
};
const DEFAULT_CHOICES = ["once", "always", "deny"];

function cleanText(value         ) {
  return typeof value === "string" ? value.trim() : "";
}

function oneLine(value         , max        ) {
  const text = cleanText(value).replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function openClawWaitingSurface(sessionKey         , turnSourceChannel          )                {
  const key = cleanText(sessionKey);
  if (!key) return null;
  const scoped = AGENT_SCOPED_KEY_RE.exec(key);
  const rest = (scoped ? scoped[2] : key).toLowerCase();
  const parts = rest.split(":");
  const head = parts[0];
  let keySurface                = null;
  if (head === "main" || head === "dashboard") {
    keySurface = OPENCLAW_WAITING_LOCAL_SURFACE;
  } else if (
    head !== "ocuclaw" &&
    SURFACE_NAME_RE.test(head) &&

    (PEER_KINDS.has(parts[1]) || (parts.length >= 4 && PEER_KINDS.has(parts[2])))
  ) {
    keySurface = head;
  }
  if (!keySurface) return null;
  const source = cleanText(turnSourceChannel).toLowerCase();
  if (LOCAL_TURN_SOURCES.has(source)) return keySurface;
  if (source === "ocuclaw") return null;
  return SURFACE_NAME_RE.test(source) ? source : keySurface;
}

function createOpenClawWaiting(deps      = {}) {
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : setTimeout;
  const clearTimer = typeof deps.clearTimer === "function" ? deps.clearTimer : clearTimeout;
  const publish = typeof deps.publish === "function" ? deps.publish : () => {};
  const getSettings = typeof deps.getSettings === "function" ? deps.getSettings : () => ({});
  const resolveApproval = typeof deps.resolveApproval === "function" ? deps.resolveApproval : null;
  const resolveQuestion = typeof deps.resolveQuestion === "function" ? deps.resolveQuestion : null;
  const describeSession = typeof deps.describeSession === "function" ? deps.describeSession : null;
  const logger = deps.logger || { info() {}, debug() {} };
  const graceMs = Number.isFinite(deps.graceMs) ? deps.graceMs : OPENCLAW_WAITING_GRACE_MS;

  const entries = new Map             ();

  function settings() {
    const raw = getSettings() || {};
    return {
      show: raw.show !== false,
      answer: raw.answer === true,
      surfaces: raw.surfaces && typeof raw.surfaces === "object" ? raw.surfaces : {},
    };
  }

  function surfaceOn(surface        , current = settings()) {
    if (!current.show) return false;
    const explicit = current.surfaces[surface];
    return typeof explicit === "boolean" ? explicit : surface === OPENCLAW_WAITING_LOCAL_SURFACE;
  }

  function itemFor(entry     , current     ) {
    const item      = {
      requestId: entry.id,
      kind: entry.kind,
      surface: entry.surface,
      sessionTitle: entry.title || null,
      preview: entry.preview,
      startedAtMs: entry.startedAtMs,
      timeoutAtMs: entry.timeoutAtMs,
      answerable: current.answer && entry.answerable,
    };
    if (entry.choices.length > 0) {
      item.choices = entry.choices.slice();
      item.multiSelect = entry.multiSelect;
    }

    if (entry.kind === "approval") item.denyReason = false;

    if (entry.kind === "approval" && entry.approvalKind === "plugin") item.approvalKind = "plugin";
    if (entry.kind === "clarify" && entry.choices.length > 0 && !entry.openText) item.allowOther = false;

    if (entry.explain) item.explain = { ...entry.explain };
    return item;
  }

  function snapshot(cleared      ) {
    const current = settings();
    const items = [];
    for (const entry of entries.values()) {
      if (entry.shown) items.push(itemFor(entry, current));
    }

    const payload      = { host: "openclaw", items };
    if (cleared) payload.cleared = cleared;
    return payload;
  }

  function send(cleared      ) {
    try {
      publish(snapshot(cleared));
    } catch (err     ) {
      logger.debug?.(`[openclaw-waiting] publish failed: ${err && err.message ? err.message : err}`);
    }
  }

  function drop(entry     , outcome               ) {
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    if (entry.graceTimer) clearTimer(entry.graceTimer);
    if (entry.expiryTimer) clearTimer(entry.expiryTimer);
    if (entry.shown) send({ requestId: entry.id, outcome });
  }

  function arm(entry     ) {
    entries.set(entry.id, entry);
    const delay = Math.max(0, entry.startedAtMs + graceMs - now());
    entry.graceTimer = setTimer(() => {
      entry.graceTimer = null;
      show(entry);
    }, delay);
    const expiresIn = Math.max(0, entry.timeoutAtMs + EXPIRY_SLACK_MS - now());
    entry.expiryTimer = setTimer(() => {
      entry.expiryTimer = null;
      drop(entry, "expired");
    }, expiresIn);
    for (const timer of [entry.graceTimer, entry.expiryTimer]) {
      if (timer && typeof timer.unref === "function") timer.unref();
    }
  }

  function show(entry     ) {
    if (entries.get(entry.id) !== entry || entry.shown) return;
    if (!surfaceOn(entry.surface)) return;
    entry.shown = true;
    send();
    if (!describeSession || entry.title) return;

    Promise.resolve()
      .then(() => describeSession(entry.sessionKey))
      .then((title     ) => {
        const cleaned = oneLine(title, 200);
        if (!cleaned || entries.get(entry.id) !== entry) return;
        entry.title = cleaned;
        if (entry.shown) send();
      })
      .catch(() => {});
  }

  function timesOf(raw     ) {
    const created = Number(raw && raw.createdAtMs);
    const startedAtMs = Number.isFinite(created) && created > 0 ? Math.floor(created) : now();
    const expires = Number(raw && raw.expiresAtMs);
    const timeoutAtMs = Number.isFinite(expires) && expires > 0
      ? Math.floor(expires)
      : startedAtMs + FALLBACK_TIMEOUT_MS;
    return { startedAtMs, timeoutAtMs };
  }

  function takeApproval(data     ) {
    const id = cleanText(data && data.id);
    const request = data && data.request && typeof data.request === "object" ? data.request : {};
    const surface = openClawWaitingSurface(request.sessionKey, request.turnSourceChannel);
    if (!id || !surface) return false;
    if (entries.has(id)) return true;
    const isPlugin = data.approvalKind === "plugin" || id.startsWith("plugin:");
    const command = isPlugin
      ? cleanText(request.title)
      : cleanText(request.command) ||
        cleanText(request.systemRunPlan && request.systemRunPlan.commandText) ||
        cleanText(request.commandPreview);
    const allowed = Array.isArray(request.allowedDecisions)
      ? request.allowedDecisions
          .map((decision     ) => DECISION_TO_CHOICE[cleanText(decision)])
          .filter(Boolean)
      : DEFAULT_CHOICES;
    const choices = DEFAULT_CHOICES.filter((choice) => allowed.includes(choice));
    const warningLines = request.commandAnalysis && Array.isArray(request.commandAnalysis.warningLines)
      ? request.commandAnalysis.warningLines.map(cleanText).filter(Boolean)
      : [];
    const description = isPlugin ? cleanText(request.description) : warningLines.join("; ");
    const explain = !isPlugin && command && command.length <= EXPLAIN_COMMAND_MAX_CHARS
      ? {
        command,
        ...(description ? { description: description.slice(0, EXPLAIN_DESCRIPTION_MAX_CHARS) } : {}),
      }
      : null;
    arm({
      id,
      kind: "approval",
      approvalKind: isPlugin ? "plugin" : "exec",
      surface,
      sessionKey: cleanText(request.sessionKey),
      title: null,
      preview: oneLine(command, PREVIEW_MAX_CHARS),
      ...timesOf(data),
      choices,
      multiSelect: false,
      answerable: choices.length > 0 && !!resolveApproval,
      explain,
      shown: false,
    });
    return true;
  }

  function takeQuestion(data     ) {
    const id = cleanText(data && data.id);
    const surface = openClawWaitingSurface(data && data.sessionKey);
    const questions = Array.isArray(data && data.questions) ? data.questions : [];
    if (!id || !surface || questions.length === 0) return false;
    if (entries.has(id)) return true;
    const first = questions[0] || {};
    const options = Array.isArray(first.options)
      ? first.options
          .map((option     ) => ({

            label: displayOptionLabel(cleanText(option && option.label)),
            value: cleanText(option && option.value) || cleanText(option && option.label),
          }))
          .filter((option     ) => option.label)
      : [];
    const secret = questions.some((question     ) =>
      question && (question.isSecret === true || (question.secretStore && typeof question.secretStore === "object")));

    const answerable = questions.length === 1 && !secret && !!resolveQuestion && !!cleanText(first.questionId);
    arm({
      id,
      kind: "clarify",
      surface,
      sessionKey: cleanText(data.sessionKey),
      title: null,
      preview: oneLine(first.question, PREVIEW_MAX_CHARS),
      ...timesOf(data),
      choices: secret ? [] : options.map((option     ) => option.label),
      multiSelect: !secret && options.length > 0 && first.multiSelect === true,
      answerable,
      questionId: cleanText(first.questionId),
      options,
      openText: options.length === 0 || first.isOther === true,
      explain: null,
      shown: false,
    });
    return true;
  }

  function observeApprovalResolved(data     ) {
    const entry = entries.get(cleanText(data && data.id));
    if (!entry || entry.kind !== "approval") return false;
    const decision = cleanText(data && data.decision);
    drop(entry, DECISION_TO_CHOICE[decision] || (decision ? decision : "expired"));
    return true;
  }

  function observeQuestionResolved(data     ) {
    const entry = entries.get(cleanText(data && data.id));
    if (!entry || entry.kind !== "clarify") return false;
    const status = cleanText(data && data.status);
    drop(entry, status === "answered" ? "answered" : status === "expired" ? "expired" : "cancelled");
    return true;
  }

  function settingsChanged() {
    const current = settings();
    let changed = false;
    for (const entry of entries.values()) {
      if (entry.shown && !surfaceOn(entry.surface, current)) {
        entry.shown = false;
        changed = true;
      } else if (!entry.shown && !entry.graceTimer && surfaceOn(entry.surface, current)) {
        entry.shown = true;
        changed = true;
      }
    }

    if (changed || entries.size > 0) send();
  }

  function errorReason(err     ) {
    const details = err && err.details && typeof err.details === "object" ? err.details : {};
    const reason = cleanText(details.reason);
    const message = cleanText(err && err.message).toLowerCase();
    if (
      reason === "APPROVAL_NOT_FOUND" ||
      reason === "APPROVAL_ALREADY_RESOLVED" ||
      reason === "QUESTION_NOT_FOUND" ||
      reason === "QUESTION_ALREADY_TERMINAL" ||
      message.includes("unknown or expired") ||
      message.includes("already resolved")
    ) {
      return "already_answered";
    }
    if (
      reason === "APPROVAL_ALLOW_ALWAYS_UNAVAILABLE" ||
      reason === "QUESTION_INVALID_ANSWER" ||
      message.includes("is unavailable for this")
    ) {
      return "choice_not_allowed";
    }
    return "unavailable";
  }

  function refused(requestId        , reason        , kind         ) {
    return { requestId, status: "refused", reason, ...(kind ? { kind } : {}) };
  }

  function questionAnswer(entry     , answer        ) {
    if (!entry.multiSelect) {
      const option = entry.options.find((candidate     ) => candidate.label === answer);
      if (option) return [option.value];
      if (!entry.openText) return null;
      return answer.length <= ANSWER_TEXT_MAX_CHARS ? [answer] : null;
    }
    let labels     ;
    try {
      labels = JSON.parse(answer);
    } catch {
      return null;
    }
    if (!Array.isArray(labels) || labels.length === 0) return null;
    const values           = [];
    for (const label of labels) {
      const option = entry.options.find((candidate     ) => candidate.label === label);
      if (!option) return null;
      if (!values.includes(option.value)) values.push(option.value);
    }
    return values;
  }

  async function answer(request     ) {
    const requestId = cleanText(request && request.requestId);
    if (!requestId) return refused("", "bad_request");
    if (!settings().answer) return refused(requestId, "answer_off");
    const entry = entries.get(requestId);
    if (!entry) return { requestId, status: "already_answered" };
    const kind = entry.kind;
    if (!entry.shown || !surfaceOn(entry.surface) || !entry.answerable) {
      return refused(requestId, "not_answerable", kind);
    }
    if (entry.answering) return { requestId, status: "already_answered", kind };
    const surfaceName = entry.surface;
    if (kind === "approval") {
      const choice = cleanText(request.choice);
      if (!choice) return refused(requestId, "bad_request", kind);
      if (!entry.choices.includes(choice)) return refused(requestId, "choice_not_allowed", kind);
      entry.answering = true;
      try {
        await resolveApproval({ kind: entry.approvalKind, id: entry.id, decision: CHOICE_TO_DECISION[choice] });
      } catch (err     ) {
        entry.answering = false;
        const reason = errorReason(err);
        if (reason === "already_answered") return { requestId, status: "already_answered", kind };
        return refused(requestId, reason, kind);
      }
      logger.info(`[openclaw-waiting] approved from glasses: surface=${surfaceName} kind=${entry.approvalKind} choice=${choice}`);
      return { requestId, status: "answered", kind, choice };
    }
    const text = typeof request.answer === "string" ? request.answer : "";
    if (!text.trim()) return refused(requestId, "bad_request", kind);
    const values = questionAnswer(entry, text.trim());
    if (!values) return refused(requestId, "choice_not_allowed", kind);
    entry.answering = true;
    try {
      await resolveQuestion({ id: entry.id, answers: { answers: { [entry.questionId]: values } } });
    } catch (err     ) {
      entry.answering = false;
      const reason = errorReason(err);
      if (reason === "already_answered") return { requestId, status: "already_answered", kind };
      return refused(requestId, reason, kind);
    }
    logger.info(`[openclaw-waiting] answered from glasses: surface=${surfaceName} kind=clarify`);
    return { requestId, status: "answered", kind };
  }

  function backfill(lists      = {}) {
    const approvals = Array.isArray(lists.approvals) ? lists.approvals : null;
    const questions = Array.isArray(lists.questions) ? lists.questions : null;
    const live = new Set        ();
    for (const row of approvals || []) live.add(cleanText(row && row.id));
    for (const row of questions || []) live.add(cleanText(row && row.id));
    for (const entry of Array.from(entries.values())) {
      const listed = entry.kind === "approval" ? approvals : questions;
      if (listed && !live.has(entry.id)) drop(entry, null);
    }
    for (const row of approvals || []) takeApproval(row);
    for (const row of questions || []) takeQuestion(row);
  }

  return {
    takeApproval,
    takeQuestion,
    observeApprovalResolved,
    observeQuestionResolved,
    settingsChanged,
    answer,
    backfill,
  };
}

module.exports = { OPENCLAW_WAITING_GRACE_MS, OPENCLAW_WAITING_LOCAL_SURFACE, OPENCLAW_WAITING_LOCAL_SURFACES, openClawWaitingSurface, createOpenClawWaiting };
