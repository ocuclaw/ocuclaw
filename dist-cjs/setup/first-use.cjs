const fs = require("node:fs");

const path = require("node:path");

const { randomUUID, createHash } = require("node:crypto");
const { setupInstallation, FIRST_USE_ERRORED_RUN_REASONS, firstUseSuccessLines } = require("./setup-journey.cjs");
const { readJsonReceipt, writeJsonReceiptDurable } = require("./private-route.cjs");

const FIRST_USE_RELAY_ENDINGS = Object.freeze([
  "passed",
  "timed-out",
  "errored",
  "phone-changed",
  "tries-exhausted",
  "needs-wearer-check",
  "welcome-unavailable",
]);
const FIRST_USE_RELAY_STAGES = Object.freeze(["reply", "receipt", "welcome"]);

function validSetupSessionKey(value     ) {
  return typeof value === "string" && !!value.trim() && value.length <= 512 && !/[\x00-\x1f]/.test(value);
}

function validRelayRun(v     ) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (!validSetupSessionKey(v.setupSessionKey) || typeof v.deliver !== "boolean" || !Number.isFinite(v.armedAt)) return false;
  if (v.ending !== undefined && (!v.ending || !FIRST_USE_RELAY_ENDINGS.includes(v.ending.outcome) ||
      !Number.isFinite(v.ending.at) || (v.ending.stage !== undefined && !FIRST_USE_RELAY_STAGES.includes(v.ending.stage)))) return false;
  if (v.wake !== undefined && (!v.wake || !["sent", "failed"].includes(v.wake.status) || !Number.isFinite(v.wake.at))) return false;
  return true;
}

const FIRST_USE_REPLY_EVIDENCE = "client_sdk_receipt";

const FIRST_USE_REPLY_EVIDENCE_REASONS = Object.freeze([
  "observation_pending",
  "observation_expired",
  "client_disconnected",
  "client_lacks_contract",
  "attribution_unavailable",
  "unsupported_reply_shape",
  "simulator_lane_not_eligible",

  "reply_run_errored",
  "reply_run_rate_limited",
  "unspecified",
]);

function firstUseReplyWasProviderError(r     ) {
  return FIRST_USE_ERRORED_RUN_REASONS.includes(r?.replyEvidenceReason);
}

const REPLY_EVIDENCE_RELAY_REASONS      = {
  deadline_expired: "observation_expired",
  recipient_disconnected: "client_disconnected",
  no_app_recipient: "client_disconnected",
  peer_lacks_contract: "client_lacks_contract",
  target_identity_missing: "attribution_unavailable",
  origin_unbound: "attribution_unavailable",
  ambiguous_recipient: "attribution_unavailable",
  reply_entry_not_found: "attribution_unavailable",
  reply_not_text: "unsupported_reply_shape",
  reply_run_errored: "reply_run_errored",
};

function firstUseReplyEvidenceReason(reason     ) {
  if (reason === null || reason === undefined) return "unspecified";
  return REPLY_EVIDENCE_RELAY_REASONS[reason] || "unspecified";
}

function classifyFirstUseReplyEvidence(seen     , allowSimulatorLane      = false) {
  if (!seen || typeof seen !== "object") return { accepted: false, reason: "unspecified" };
  if (seen.status === "pending") return { accepted: false, reason: "observation_pending" };
  if (seen.status !== "sdk_accepted") return { accepted: false, reason: firstUseReplyEvidenceReason(seen.reason) };
  const lane = seen.evidence?.lane;
  if (lane === "device") return { accepted: true, reason: null };
  if (lane === "simulator") {
    return allowSimulatorLane === true ? { accepted: true, reason: null }
      : { accepted: false, reason: "simulator_lane_not_eligible" };
  }
  return { accepted: false, reason: "unspecified" };
}

function createFirstUseStore(stateDir     , options      = {}) {
  const installation = setupInstallation(stateDir);
  const file = stateDir ? path.join(stateDir, "ocuclaw", "setup-first-use.json") : null;
  const now = options.now ?? Date.now;
  function read() {
    if (!file || !installation.id) throw new Error("setup-state-unavailable");
    const result = readJsonReceipt(file);
    if (result.status === "missing") return null;
    const r = result.record;
    if (result.status !== "ok" || r.backend !== "openclaw" || r.installationId !== installation.id ||
        !["awaiting-reply", "awaiting-confirmation", "awaiting-welcome", "completed"].includes(r.status) ||
        typeof r.attemptId !== "string" || !r.attemptId || typeof r.sessionKey !== "string" || !r.sessionKey ||
        !Number.isFinite(r.startedAt) ||
        (r.status !== "awaiting-reply" && (!r.reply?.runId || !r.reply?.messageId || !Number.isFinite(r.reply?.completedAt))) ||

        (["awaiting-welcome", "completed"].includes(r.status) && r.confirmation === undefined && r.replyEvidence === undefined) ||
        (r.confirmation !== undefined && (!["direct-wearer-terminal", "host-setup-conversation", "test-input"].includes(r.confirmation.source) || !Number.isFinite(r.confirmation.at))) ||
        (r.confirmation !== undefined && !["awaiting-welcome", "completed"].includes(r.status)) ||
        (r.replyEvidence !== undefined && (r.replyEvidence !== "client_sdk_receipt" ||
          r.completionPolicy !== "reply-and-welcome" || r.confirmation !== undefined ||
          !["awaiting-welcome", "completed"].includes(r.status) || !Number.isFinite(r.replyEvidenceAt))) ||
        (r.replyEvidenceAt !== undefined && r.replyEvidence === undefined) ||
        (r.replyEvidenceReason !== undefined &&
          (!FIRST_USE_REPLY_EVIDENCE_REASONS.includes(r.replyEvidenceReason) || r.replyEvidence !== undefined)) ||
        (r.observation !== undefined && (r.observation?.answer !== "no" || !Number.isFinite(r.observation.at) ||
          !["host-setup-conversation", "test-input"].includes(r.observation.source))) ||
        (r.completionPolicy === undefined && (r.phone !== undefined || r.completionPolicyVersion !== undefined)) ||
        (r.completionPolicy !== undefined && (r.completionPolicy !== "reply-and-welcome" || r.completionPolicyVersion !== 2 ||
          typeof r.phone?.clientId !== "string" || !r.phone.clientId || typeof r.phone?.generation !== "string" || !r.phone.generation)) ||
        (r.status === "awaiting-welcome" && r.completionPolicy !== "reply-and-welcome") ||
        (r.welcome !== undefined && (r.completionPolicy !== "reply-and-welcome" ||
          !["awaiting-welcome", "completed"].includes(r.status) ||
          !["in-progress", "failed", "completed"].includes(r.welcome?.status) ||
          !Number.isInteger(r.welcome.attempts) || r.welcome.attempts < 1 || r.welcome.attempts > 2 ||
          typeof r.welcome.id !== "string" || !r.welcome.id || !Number.isFinite(r.welcome.startedAt) ||
          (r.welcome.surfaceId !== undefined && (typeof r.welcome.surfaceId !== "string" || !r.welcome.surfaceId)) ||
          (r.welcome.declarationId !== undefined && (typeof r.welcome.declarationId !== "string" || !r.welcome.declarationId)) ||
          (r.welcome.status === "completed" && (r.status !== "completed" || !r.welcome.surfaceId || !Number.isFinite(r.welcome.completedAt) ||
            !["dismissed", "back"].includes(r.welcome.outcome) ||
            r.welcome.source !== (r.confirmation?.source === "test-input" ? "test-input" : "bound-phone-gesture"))))) ||
        (r.status === "completed" && r.completionPolicy === "reply-and-welcome" && r.welcome?.status !== "completed") ||
        (r.relayRun !== undefined && !validRelayRun(r.relayRun))) {
      throw new Error("setup-state-unreadable-or-foreign");
    }
    return r;
  }
  function change(update     ) {
    if (!file) throw new Error("setup-state-unavailable");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    let fd;
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (_) { throw new Error("setup-state-locked"); }
    try {
      const before = read();
      const after = update(before);
      if (after !== before) writeJsonReceiptDurable(file, after);
      return after;
    } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  function freshRelayRun(input     ) {
    if (!validSetupSessionKey(input?.setupSessionKey)) throw new Error("setup-session-required");
    return { setupSessionKey: input.setupSessionKey, deliver: input.deliver === true, armedAt: now() };
  }
  return {
    read,

    begin(sessionKey     , retry = false, phone      = null, relayRun      = null) {
      const run = relayRun ? freshRelayRun(relayRun) : null;
      return change((r     ) => {
        if (r && (!retry || (r.status === "completed" && r.confirmation?.source !== "test-input"))) {
          if (sessionKey && sessionKey !== r.sessionKey) throw new Error("setup-session-mismatch");
          let next = r;
          if (phone && !r.completionPolicy && r.status !== "completed") {
            next = { ...next, completionPolicyVersion: 2, completionPolicy: "reply-and-welcome", phone };
          }
          if (run && r.status !== "completed") next = { ...next, relayRun: run };
          return next;
        }
        sessionKey = sessionKey || r?.sessionKey;
        if (typeof sessionKey !== "string" || !sessionKey.trim() || sessionKey.length > 512 || /[\x00-\x1f]/.test(sessionKey)) throw new Error("setup-session-required");
        return { schemaVersion: 1, backend: "openclaw", installationId: installation.id,
          ...(phone ? { completionPolicyVersion: 2, completionPolicy: "reply-and-welcome", phone } : {}),
          attemptId: randomUUID(), sessionKey, startedAt: now(), status: "awaiting-reply",
          ...(run ? { relayRun: run } : {}) };
      });
    },

    armRelayRun(attemptId     , relayRun     ) {
      const run = freshRelayRun(relayRun);
      return change((r     ) => {
        if (!r || r.attemptId !== attemptId || r.status === "completed") return r;
        return { ...r, relayRun: run };
      });
    },

    endRelayRun(attemptId     , ending     ) {
      return change((r     ) => {
        if (!r?.relayRun || r.attemptId !== attemptId || r.relayRun.ending) return r;
        if (!FIRST_USE_RELAY_ENDINGS.includes(ending?.outcome)) throw new Error("setup-relay-ending-invalid");
        return { ...r, relayRun: { ...r.relayRun, ending: {
          outcome: ending.outcome, at: now(),
          ...(FIRST_USE_RELAY_STAGES.includes(ending.stage) ? { stage: ending.stage } : {}),
        } } };
      });
    },
    noteRelayWake(attemptId     , status     ) {
      return change((r     ) => {
        if (!r?.relayRun?.ending || r.attemptId !== attemptId || !["sent", "failed"].includes(status)) return r;
        return { ...r, relayRun: { ...r.relayRun, wake: { status, at: now() } } };
      });
    },
    completeReply(candidate     ) {
      return change((r     ) => {
        if (!r || r.status !== "awaiting-reply" || candidate.attemptId !== r.attemptId ||
            candidate.installationId !== installation.id || candidate.backend !== "openclaw" ||
            candidate.sessionKey !== r.sessionKey || candidate.source !== "phone_ui" ||
            (r.phone && !sameFirstUsePhone(r.phone, candidate.phone)) ||
            !candidate.messageId || !candidate.runId || !Number.isFinite(candidate.sendStartedAt) ||
            !Number.isFinite(candidate.completedAt) || candidate.sendStartedAt < r.startedAt ||
            candidate.completedAt < candidate.sendStartedAt) return r;
        return { ...r, status: "awaiting-confirmation", reply: {
          messageId: candidate.messageId, runId: candidate.runId,
          sentAt: candidate.sendStartedAt, completedAt: candidate.completedAt,
        } };
      });
    },

    applyReplyEvidence(input     ) {
      return change((r     ) => {
        if (!r || r.status !== "awaiting-confirmation" || input.binding !== firstUseBinding(r)) return r;

        if (r.completionPolicy !== "reply-and-welcome") return r;
        if (input.accepted === true) {
          const { replyEvidenceReason, ...rest } = r;
          return { ...rest, status: "awaiting-welcome",
            replyEvidence: FIRST_USE_REPLY_EVIDENCE, replyEvidenceAt: now() };
        }
        const reason = FIRST_USE_REPLY_EVIDENCE_REASONS.includes(input.reason) ? input.reason : "unspecified";
        if (r.replyEvidenceReason === reason) return r;
        return { ...r, replyEvidenceReason: reason };
      });
    },
    confirm(input     ) {
      return change((r     ) => {
        if (!r || input.installationId !== installation.id || input.attemptId !== r.attemptId ||
            input.sessionKey !== r.sessionKey || input.runId !== r.reply?.runId ||
            input.answer !== "SEEN ON G2" || input.source !== "direct-wearer-terminal") throw new Error("setup-confirmation-mismatch");
        if (r.status === "completed" && (r.replyEvidence === FIRST_USE_REPLY_EVIDENCE ||
            r.confirmation?.source === "direct-wearer-terminal" || input.testInput === true)) return r;
        if (r.status === "awaiting-welcome") return r;
        if (r.status !== "awaiting-confirmation" && r.confirmation?.source !== "test-input") throw new Error("setup-reply-required");

        if (firstUseReplyWasProviderError(r)) throw new Error("setup-reply-run-errored");

        return { ...r, status: r.completionPolicy === "reply-and-welcome" ? "awaiting-welcome" : "completed", confirmation: { at: now(),
          source: input.testInput === true ? "test-input" : "direct-wearer-terminal" } };
      });
    },
    confirmConversation(input     ) {
      return change((r     ) => {
        if (!r?.reply || input.binding !== firstUseBinding(r) || input.sessionKey !== r.sessionKey) {
          throw new Error("setup-confirmation-mismatch");
        }
        if (["completed", "awaiting-welcome"].includes(r.status)) return r;

        if (input.answer === "no") return r.observation?.answer === "no" ? r : { ...r, observation: { answer: "no", at: now(), source: input.testInput === true ? "test-input" : "host-setup-conversation" } };
        if (input.answer !== "yes") return r;
        if (r.status !== "awaiting-confirmation") throw new Error("setup-reply-required");

        if (firstUseReplyWasProviderError(r)) throw new Error("setup-reply-run-errored");
        return { ...r, status: r.completionPolicy === "reply-and-welcome" ? "awaiting-welcome" : "completed", confirmation: { at: now(),
          source: input.testInput === true ? "test-input" : "host-setup-conversation",
          reportedVia: "host-setup-conversation" } };
      });
    },
    beginWelcome(input     ) {
      return change((r     ) => {
        if ((!r?.confirmation && r?.replyEvidence !== FIRST_USE_REPLY_EVIDENCE) ||
            input.binding !== firstUseBinding(r)) throw new Error("setup-confirmation-mismatch");
        if (r.status === "completed") return r;
        if (r.status !== "awaiting-welcome" || !sameFirstUsePhone(r.phone, input.phone)) throw new Error("setup-welcome-mismatch");

        if (input.auto === true && r.welcome && input.retry !== true) {
          return { ...r, welcome: { id: randomUUID(), status: "in-progress",
            attempts: r.welcome.attempts, startedAt: now() } };
        }
        if (r.welcome && input.retry !== true) throw new Error("setup-welcome-retry-required");
        if (r.welcome?.attempts >= 2) throw new Error("setup-welcome-retry-exhausted");
        return { ...r, welcome: { id: randomUUID(), status: "in-progress",
          attempts: (r.welcome?.attempts ?? 0) + 1, startedAt: now() } };
      });
    },

    welcomeOpened(id        , surfaceId        , declarationId         ) {
      return change((r     ) => {
        if (r?.welcome?.id !== id || r.welcome.status !== "in-progress" || !surfaceId ||
            (declarationId !== undefined && (typeof declarationId !== "string" || !declarationId))) throw new Error("setup-welcome-mismatch");
        return { ...r, welcome: { ...r.welcome, surfaceId, ...(declarationId ? { declarationId } : {}) } };
      });
    },
    finishWelcome(input     ) {
      return change((r     ) => {
        if (r?.welcome?.id !== input.id || r.welcome.surfaceId !== input.surfaceId ||
            r.welcome.declarationId !== input.declarationId ||
            !sameFirstUsePhone(r.phone, input.phone)) throw new Error("setup-welcome-mismatch");
        if (r.welcome.status === "completed") return r;
        if (r.welcome.status !== "in-progress") throw new Error("setup-welcome-mismatch");
        const dismissed = ["dismissed", "back"].includes(input.outcome) && !input.reason;
        return { ...r, status: dismissed ? "completed" : "awaiting-welcome", welcome: {
          ...r.welcome, status: dismissed ? "completed" : "failed",
          ...(dismissed ? { completedAt: now(), outcome: input.outcome,
            source: r.confirmation?.source === "test-input" ? "test-input" : "bound-phone-gesture" }
            : { reason: input.reason ?? "dismissal-unconfirmed" }),
        } };
      });
    },
  };
}

function sameFirstUsePhone(expected     , actual     ) {
  return !!expected && !!actual && typeof expected.generation === "string" && !!expected.generation &&
    expected.generation === actual.generation;
}

function firstUseBinding(r     ) {
  if (!r?.reply) return null;
  return createHash("sha256").update(JSON.stringify([
    r.backend, r.installationId, r.attemptId, r.sessionKey, r.startedAt,
    r.reply.messageId, r.reply.runId, r.reply.completedAt,
    ...(r.phone ? [r.phone.clientId, r.phone.generation, r.completionPolicy] : []),
  ])).digest("hex");
}

const FIRST_USE_TOOL_OPERATIONS = Object.freeze([
  "first_use_begin", "first_use_wait", "first_use_retry", "first_use_confirm",
  "first_use_welcome", "first_use_welcome_retry",
]);

const FIRST_USE_WAIT_MAX_MS = 60000;

const FIRST_USE_RECEIPT_SETTLE_MAX_MS = 30000;

function validateFirstUseParams(params     ) {
  const allowed = params?.operation === "first_use_confirm" ? ["operation", "binding", "answer"]
    : params?.operation === "first_use_wait" ? ["operation", "timeoutMs"]
    : ["first_use_welcome", "first_use_welcome_retry"].includes(params?.operation) ? ["operation", "binding", "timeoutMs"] : ["operation"];
  if (!params || !FIRST_USE_TOOL_OPERATIONS.includes(params.operation) ||
      Object.keys(params).some(key => !allowed.includes(key)) ||
      (params.operation === "first_use_confirm" &&
        (!/^[a-f0-9]{64}$/.test(params.binding) || !["yes", "no"].includes(params.answer))) ||
      (["first_use_welcome", "first_use_welcome_retry"].includes(params.operation) && !/^[a-f0-9]{64}$/.test(params.binding)) ||
      (params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 0 || params.timeoutMs > FIRST_USE_WAIT_MAX_MS)) ||
      (["first_use_welcome", "first_use_welcome_retry"].includes(params.operation) && params.timeoutMs !== undefined && params.timeoutMs < 2000)) {
    throw new Error("invalid_input: invalid first-use operation or binding");
  }
}

function runFirstUseOperation(store     , operation     , input     , readPhoneSession     , readPhoneContext      = null, observeReplyEvidence      = null) {
  let r = store.read();

  const completed = r?.status === "completed" && r.confirmation?.source !== "test-input";
  if (operation === "first_use_begin" || operation === "first_use_retry") {
    if (!completed) {
      const sessionKey = readPhoneSession();
      const phone = readPhoneContext ? readPhoneContext() : null;
      if (r?.phone && operation !== "first_use_retry" && !sameFirstUsePhone(r.phone, phone)) throw new Error("setup-phone-binding-changed");
      r = store.begin(sessionKey, operation === "first_use_retry", phone, input?.relayRun ?? null);
    }
  } else if (operation === "first_use_confirm") {
    if (!completed && r?.phone && !sameFirstUsePhone(r.phone, readPhoneContext?.())) throw new Error("setup-phone-binding-changed");

    r = observeReplyEvidenceInto(store, r, observeReplyEvidence);
    r = store.confirmConversation({ ...input, sessionKey: completed ? r.sessionKey : readPhoneSession() });
  } else if (operation !== "first_use_wait") {
    throw new Error("setup-first-use-operation-invalid");
  }
  if (!r) throw new Error("setup-attempt-required");
  if (!completed && operation === "first_use_wait" && readPhoneSession() !== r.sessionKey) throw new Error("setup-session-mismatch");
  if (!completed && operation === "first_use_wait" && r.phone && !sameFirstUsePhone(r.phone, readPhoneContext?.())) throw new Error("setup-phone-binding-changed");

  if (operation === "first_use_wait") r = observeReplyEvidenceInto(store, r, observeReplyEvidence);
  return firstUseResult(r);
}

function observeReplyEvidenceInto(store     , r     , observeReplyEvidence     ) {
  if (typeof observeReplyEvidence !== "function" || !r ||
      r.status !== "awaiting-confirmation" || r.completionPolicy !== "reply-and-welcome") return r;
  let verdict      = null;
  try { verdict = observeReplyEvidence(r); } catch (_) { verdict = null; }
  if (!verdict) return r;
  return store.applyReplyEvidence({ binding: firstUseBinding(r), ...verdict }) ?? r;
}

function firstUseResult(r     ) {
  if (!r) throw new Error("setup-attempt-required");
  return {
    status: r.status === "completed" && r.confirmation?.source === "test-input" ? "awaiting-confirmation" : r.status,
    sessionKey: r.sessionKey, binding: firstUseBinding(r),
    replyCompletedAt: r.reply?.completedAt ?? null,
    confirmationSource: r.confirmation?.source ?? null,

    replyEvidence: r.replyEvidence ?? (r.confirmation || r.status === "completed" ? "wearer_confirmed" : null),
    replyEvidenceReason: r.replyEvidenceReason ?? null,

    replyWasProviderError: firstUseReplyWasProviderError(r),
    observation: r.observation ?? null,
    acceptance: r.confirmation?.source === "test-input" ? "test-input-only" : r.confirmation ? "wearer-reported" : "not-confirmed",
    welcome: r.welcome ? { status: r.welcome.status, attempts: r.welcome.attempts,
      reason: r.welcome.reason ?? null, source: r.welcome.source ?? null } :
      { status: r.completionPolicy === "reply-and-welcome" ? "not-started" : "not-required-legacy" },
    nextOperations: r.status === "awaiting-reply" ? ["first_use_wait"]

      : r.status === "awaiting-confirmation" ? (r.observation?.answer === "no" || firstUseReplyWasProviderError(r)) ? ["first_use_retry"] : ["first_use_confirm"]
      : r.status === "awaiting-welcome" ? r.welcome ? (r.welcome.attempts < 2 ? ["first_use_welcome_retry"] : []) : ["first_use_welcome"]

      : r.status === "completed" && r.confirmation?.source === "test-input" ? ["first_use_retry"]

      : r.status === "completed" ? ["wrap_feedback"] : [],
    ...(r.status === "awaiting-welcome" && (!r.welcome || r.welcome.attempts < 2)
      ? { action: welcomeAction(r) } : {}),

    ...(r.status === "completed" && r.confirmation?.source !== "test-input"
      ? { say: firstUseSuccessLines(r) } : {}),

    relayRun: r.relayRun ? {
      status: r.relayRun.ending ? "ended" : "running",
      outcome: r.relayRun.ending?.outcome ?? null,
      stage: r.relayRun.ending?.stage ?? null,
      wake: r.relayRun.wake?.status ?? null,
    } : null,
  };
}

function welcomeAction(r     ) {
  const brief = "tell the wearer a welcome image is coming and to double-tap it to return to the conversation";
  return r.welcome
    ? `The previous welcome wait ended (${r.welcome.reason ?? "interrupted"}). Before calling first_use_welcome_retry, ${brief}; offer that one retry with this binding.`
    : `Before calling first_use_welcome, ${brief}; then call it in the same turn with this binding.`;
}

function createFirstUseObserver(store     , options      = {}) {
  const pending = new Map();
  const now = options.now ?? Date.now;
  function prune() {
    for (const [id, p] of pending) if (now() - p.sendStartedAt > 300000) pending.delete(id);
  }
  function join(p     ) {
    const final = p.finals.get(p.runId);
    if (!final) return;
    if (p.phone && options.readPhone) {
      try {
        const current = options.readPhone();
        if (!sameFirstUsePhone(p.phone, current) || current.sessionKey !== p.sessionKey) {
          pending.delete(p.messageId);
          return;
        }
      } catch (_) { pending.delete(p.messageId); return; }
    }
    store.completeReply({ ...p, completedAt: final, backend: "openclaw", source: "phone_ui" });
    pending.delete(p.messageId);
  }
  return {
    sent({ backend, source, sessionKey, gatewaySessionKey, messageId, phone }     ) {
      prune();
      if (backend !== "openclaw" || source !== "phone_ui" || !messageId) return;
      const r = store.read();
      if (!r || r.status !== "awaiting-reply" || r.sessionKey !== sessionKey) return;
      if (r.phone && !sameFirstUsePhone(r.phone, phone)) return;
      pending.set(messageId, { attemptId: r.attemptId, installationId: r.installationId,
        sessionKey, gatewaySessionKey: gatewaySessionKey || sessionKey,
        messageId, phone, sendStartedAt: now(), finals: new Map(), runId: null });
      while (pending.size > 32) pending.delete(pending.keys().next().value);
    },
    ack(messageId     , result     ) {
      prune();
      const p = pending.get(messageId);
      if (!p) return;
      if (!result?.runId || !["accepted", "queued"].includes(result.status ?? "accepted")) { pending.delete(messageId); return; }
      p.runId = result.runId;
      join(p);
    },
    failed(messageId     ) { pending.delete(messageId); },
    clear() { pending.clear(); },
    reply(data     ) {
      prune();
      if (data?.role !== "assistant" || !data.runId || !data.sessionKey || data.turnActive === true ||
          data.retag === true || data.messageKind === "narration" ||
          !Array.isArray(data.content) || !data.content.some((b     ) => b.type === "text" && b.text?.trim())) return;
      for (const p of pending.values()) {
        const expectedKey = p.gatewaySessionKey;
        const sessionMatches = data.sessionKey === expectedKey ||
          (!expectedKey.startsWith("agent:") && data.sessionKey === `agent:main:${expectedKey}`);
        if (!sessionMatches || (p.runId && p.runId !== data.runId)) continue;
        p.finals.set(data.runId, now());
        while (p.finals.size > 16) p.finals.delete(p.finals.keys().next().value);
        join(p);
      }
    },
  };
}

module.exports = { createFirstUseStore, createFirstUseObserver, runFirstUseOperation, firstUseResult, sameFirstUsePhone, firstUseBinding, classifyFirstUseReplyEvidence, firstUseReplyEvidenceReason, FIRST_USE_REPLY_EVIDENCE, FIRST_USE_REPLY_EVIDENCE_REASONS, FIRST_USE_RECEIPT_SETTLE_MAX_MS, FIRST_USE_ERRORED_RUN_REASONS, firstUseReplyWasProviderError, FIRST_USE_RELAY_ENDINGS, FIRST_USE_RELAY_STAGES, observeReplyEvidenceInto };
