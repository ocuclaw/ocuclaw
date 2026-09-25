const { randomUUID } = require("node:crypto");
const { firstUseBinding, sameFirstUsePhone, FIRST_USE_RECEIPT_SETTLE_MAX_MS } = require("./first-use.cjs");
const { FIRST_USE_ERRORED_RUN_REASONS, FIRST_USE_PROVIDER_ERROR_ACTION, FIRST_USE_PROVIDER_ERROR_CLASSES, firstUseSuccessLines } = require("./setup-journey.cjs");

const FIRST_USE_RELAY_REPLY_WINDOW_MS = 600000;
const FIRST_USE_RELAY_WELCOME_WINDOW_MS = 300000;
const FIRST_USE_RELAY_TICK_MS = 500;
const FIRST_USE_RELAY_MAX_AUTO_RENDERS = 4;
const FIRST_USE_RELAY_WAKE_RETRY_MS = Object.freeze([2000, 5000, 15000]);
const FIRST_USE_RELAY_PAIRED_PHONE_WAIT_MS = 60000;

const FIRST_USE_RELAY_SETUP_SESSION_TTL_MS = 3 * 60 * 60 * 1000;

const PHONE_GONE_REASONS = ["setup-phone-session-ambiguous-or-disconnected", "setup-phone-session-unavailable"];

const WAKE_HEADER = "[ocuclaw setup wake] Automatic message from the OcuClaw relay.";
const WAKE_FOOTER = "Open your reply by saying what happened.";

const WAKE_PASSED = "The first-use test passed: the phone got a reply, the glasses showed it, and the welcome card was double-tapped. OcuClaw setup is complete.";

const WAKE_FULL_WRAP = "the full wrap: read references/wrap-feedback.md (wrap_feedback) and give every item in order, donation line last";

const WAKE_WRAP_NO_EXEC = "The route and pairing are already verified, so run no probe commands for the wrap (no tailscale, openclaw or network checks); reading the skill's reference files is fine. Take facts from this chat and ocuclaw_setup, and write unknown for anything missing.";

const FIRST_USE_RELAY_ARM_LINES = Object.freeze([
  "On your phone, in OcuClaw, send hello (any message works).",
  "Read the reply on your glasses. A welcome card follows: double-tap it.",
  "You do not need to type here. This chat continues by itself when the test ends.",
]);
const FIRST_USE_RELAY_ARM_ACTION =
  "Say the `say` lines as your final message and end your turn now. Do not call first_use_wait or first_use_welcome: the relay runs the test and wakes this chat with the result.";
const FIRST_USE_RELAY_WELCOME_LINES = Object.freeze([
  "A welcome card is coming to your glasses. Double-tap it.",
  "You do not need to type here. This chat continues by itself when the test ends.",
]);

function token(value     , pattern     , fallback     ) {
  const raw = typeof value === "string" ? value : "";
  return pattern.test(raw) ? raw : fallback;
}

function buildFirstUseWakeMessage(outcome     , detail      = {}) {
  const binding = token(detail.binding, /^[a-f0-9]{64}$/, null);
  const errorClass = FIRST_USE_PROVIDER_ERROR_CLASSES.includes(detail.errorClass) ? detail.errorClass : "model_error";
  const reason = token(detail.reason, /^[a-z_-]{1,40}$/, "unspecified");
  const minutes = Math.max(1, Math.round((Number(detail.windowMs) || FIRST_USE_RELAY_REPLY_WINDOW_MS) / 60000));
  const quotedLines = (Array.isArray(detail.lines) ? detail.lines : []).map((line     ) => JSON.stringify(String(line))).join(" ");
  let body     ;
  let footer      = WAKE_FOOTER;
  switch (outcome) {
    case "passed":
      body = detail.linesShown === true
        ? [WAKE_PASSED,
          "The completion lines above are already shown in this chat, so do not repeat them.",
          `Continue now with ${WAKE_FULL_WRAP}.`,
          WAKE_WRAP_NO_EXEC]

        : [WAKE_PASSED,
          `Start your reply at once with these lines, one per line, word for word, before any tool call, file read or other text: ${quotedLines}`,
          `Only after those lines, continue with ${WAKE_FULL_WRAP}.`,
          WAKE_WRAP_NO_EXEC];
      footer = null;
      break;
    case "timed-out":
      body = detail.stage === "welcome"
        ? ["First-use test result: the welcome card on the glasses was not double-tapped in time. The reply itself reached the glasses. Setup is not complete.",
          binding ? `Offer one more try; on a yes, call first_use_welcome_retry with binding ${binding}.` : "Offer one more try with first_use_welcome_retry."]
        : [`First-use test result: TIMED OUT. No message from the phone was answered within ${minutes} minutes. Setup is not complete.`,
          "Ask the person to open OcuClaw on the phone, and offer to start the test again with first_use_retry."];
      break;
    case "errored":
      body = [`First-use test result: the phone message reached your agent, but the model returned an error (class ${errorClass}). OcuClaw is installed; setup is not complete.`,
        FIRST_USE_PROVIDER_ERROR_ACTION, "Give the one fix for that class, then offer first_use_retry."];
      break;
    case "phone-changed":
      body = ["First-use test result: the phone's session on this relay changed during the test (another conversation, another phone, or a relay restart), so this attempt cannot finish. Setup is not complete.",
        "Ask the person to open OcuClaw on the phone in the conversation they want, then start again with first_use_retry."];
      break;
    case "tries-exhausted":
      body = ["First-use test result: the welcome card was shown twice without a double-tap. Setup is not complete. Do not show it again.",
        "Report the welcome as pending and ask whether the card appeared on the glasses."];
      break;
    case "needs-wearer-check":
      body = [`First-use test result: the reply was sent to the phone, but the phone could not report whether it reached the glasses (reason ${reason}).`,
        "Ask the person, open-ended with no answer choices: \"Did that reply appear on your glasses? Type yes or no.\" Then end your turn.",
        binding ? `Record their answer with first_use_confirm (binding ${binding}) only from their own next message.` : "Record their answer with first_use_confirm only from their own next message."];
      break;
    case "welcome-unavailable":
      body = [`First-use test result: the welcome card could not be shown (reason ${reason}). The reply itself was accepted. Setup is not complete.`,
        reason === "surface-busy" ? "Something else is open on the glasses. Ask the person to close it, then offer first_use_welcome_retry." : "Report the welcome as pending."];
      break;
    case "phone-paired":
      body = detail.connected === true
        ? ["Setup event: the phone finished pairing and is connected to this relay.",
          "Continue with the end-to-end check now: call ocuclaw_setup first_use_begin, then say its `say` lines as your final message and end your turn."]
        : ["Setup event: the phone finished pairing but has not connected to this relay yet.",
          "Ask the person to open OcuClaw on the phone. When they say it is open, call ocuclaw_setup first_use_begin."];
      break;
    default:
      throw new Error("setup-relay-ending-invalid");
  }
  return [WAKE_HEADER, ...body, ...(footer ? [footer] : [])].join(" ");
}

const LOCAL_CHANNELS = ["", "webchat", "tui", "cli", "internal", "ocuclaw", "gateway"];
function firstUseSetupSessionFromContext(ctx     ) {
  const sessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  if (!sessionKey || sessionKey.length > 512 || /[\x00-\x1f]/.test(sessionKey)) return null;
  const channel = typeof ctx.messageChannel === "string" ? ctx.messageChannel.trim().toLowerCase() : "";
  return { setupSessionKey: sessionKey, deliver: !LOCAL_CHANNELS.includes(channel) };
}

function stageOf(record     ) {
  return record?.status === "awaiting-reply" ? "reply" : record?.status === "awaiting-confirmation" ? "receipt" : "welcome";
}

function createFirstUseRelayRun(deps     ) {
  const store = deps.store;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const windows = {
    replyMs: FIRST_USE_RELAY_REPLY_WINDOW_MS,
    welcomeMs: FIRST_USE_RELAY_WELCOME_WINDOW_MS,
    receiptSettleMs: FIRST_USE_RECEIPT_SETTLE_MAX_MS,
    tickMs: FIRST_USE_RELAY_TICK_MS,
    maxAutoRenders: FIRST_USE_RELAY_MAX_AUTO_RENDERS,
    wakeRetryMs: FIRST_USE_RELAY_WAKE_RETRY_MS,
    pairedPhoneWaitMs: FIRST_USE_RELAY_PAIRED_PHONE_WAIT_MS,
    setupSessionTtlMs: FIRST_USE_RELAY_SETUP_SESSION_TTL_MS,
    ...(deps.windows || {}),
  };
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms     , signal      = null) =>
    new Promise      ((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      signal?.addEventListener?.("abort", done, { once: true });
    });
  let run      = null;
  let setupSession      = null;
  const wakeRunIds      = new Set();
  const background      = new Set();
  let stopped = false;

  function track(promise     ) {
    background.add(promise);
    promise.finally(() => background.delete(promise));
    return promise;
  }

  function changed() { try { deps.onChange?.(); } catch (_) {  } }

  function readRecord() {
    try { return { ok: true, record: store.read() }; } catch (error) { return { ok: false, error }; }
  }

  function readPhone() {
    try { return deps.readPhone(); } catch (_) { return null; }
  }

  async function sendWake(sessionKey     , message     , deliver     , attemptId     ) {
    const idempotencyKey = `ocuclaw-setup-wake-${randomUUID()}`;

    wakeRunIds.add(idempotencyKey);
    while (wakeRunIds.size > 16) wakeRunIds.delete(wakeRunIds.values().next().value);
    const delays = [0, ...windows.wakeRetryMs];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await sleep(delays[i], null);
      if (stopped) break;
      try {
        const response      = await deps.wake({ sessionKey, message, idempotencyKey,
          ...(deliver ? { deliver: true, bestEffortDeliver: true } : {}) });
        if (typeof response?.runId === "string" && response.runId) wakeRunIds.add(response.runId);
        log("first_use_wake_sent", { attempt: i + 1, deliver: deliver === true, messageChars: message.length });
        if (attemptId) { try { store.noteRelayWake(attemptId, "sent"); } catch (_) {  } }
        return true;
      } catch (error) {
        log("first_use_wake_failed", { attempt: i + 1, error: error instanceof Error ? error.message : "wake-failed" });
      }
    }
    if (attemptId) { try { store.noteRelayWake(attemptId, "failed"); } catch (_) {  } }
    return false;
  }

  async function showLines(sessionKey     , lines     ) {
    if (typeof deps.showLines !== "function" || !lines.length) return false;
    try {
      await deps.showLines({ sessionKey, message: lines.join("\n") });
      log("first_use_lines_shown", { lines: lines.length });
      return true;
    } catch (error) {
      log("first_use_lines_show_failed", { error: error instanceof Error ? error.message.slice(0, 120) : "show-failed" });
      return false;
    }
  }

  async function end(ctl     , outcome     , stage     , detail      = {}) {
    let r      = null;
    try { r = store.endRelayRun(ctl.attemptId, { outcome, stage }); } catch (_) { r = null; }
    if (!r?.relayRun?.ending || r.relayRun.ending.outcome !== outcome || r.attemptId !== ctl.attemptId) return;
    changed();
    log("first_use_relay_ended", { outcome, stage });
    const lines = outcome === "passed" ? firstUseSuccessLines(r) : [];
    const linesShown = outcome === "passed" && r.relayRun.deliver !== true
      ? await showLines(r.relayRun.setupSessionKey, lines) : false;
    const message = buildFirstUseWakeMessage(outcome, { ...detail, stage, binding: firstUseBinding(r),
      lines, linesShown, windowMs: windows.replyMs });
    await sendWake(r.relayRun.setupSessionKey, message, r.relayRun.deliver === true, r.attemptId);
  }

  async function drive(ctl     ) {
    let receiptSince      = null;
    let welcomeStartedAt      = null;
    let autoRenders = 0;
    let rebound = false;
    let retryWelcome = ctl.retryWelcome === true;
    while (!ctl.abort.signal.aborted) {
      const read      = readRecord();
      if (!read.ok) { await sleep(windows.tickMs, ctl.abort.signal); continue; }
      const r = read.record;
      if (!r || r.attemptId !== ctl.attemptId || !r.relayRun || r.relayRun.ending) return;
      if (r.status === "completed") return end(ctl, "passed", "welcome");
      const phone = readPhone();
      if (phone && r.phone && (phone.sessionKey !== r.sessionKey || !sameFirstUsePhone(r.phone, phone))) {

        if (r.status === "awaiting-reply" && !rebound) {
          rebound = true;
          try {
            const next = store.begin(phone.sessionKey, true, phone, r.relayRun);
            ctl.attemptId = next.attemptId;
            changed();
            log("first_use_relay_rebound", {});
            continue;
          } catch (_) { return end(ctl, "phone-changed", "reply"); }
        }
        return end(ctl, "phone-changed", stageOf(r));
      }
      if (r.status === "awaiting-reply") {
        const errored = typeof deps.erroredRunSince === "function" ? deps.erroredRunSince(r.startedAt) : null;
        if (errored) return end(ctl, "errored", "reply", { errorClass: errored.class });
        if (now() - r.relayRun.armedAt >= windows.replyMs) return end(ctl, "timed-out", "reply");
      } else if (r.status === "awaiting-confirmation") {

        if (r.observation?.answer === "no") return;
        let next = r;
        if (!FIRST_USE_ERRORED_RUN_REASONS.includes(r.replyEvidenceReason)) {
          try { next = deps.observe(r) ?? r; } catch (_) { next = r; }
        }
        if (next.status === "awaiting-welcome") { changed(); continue; }
        const reason = next.replyEvidenceReason ?? null;
        if (FIRST_USE_ERRORED_RUN_REASONS.includes(reason)) {
          const settled = typeof deps.settledRunErrored === "function" ? deps.settledRunErrored(next) : null;
          return end(ctl, "errored", "receipt", { errorClass: settled?.class });
        }
        if (reason === null || reason === "observation_pending") {
          if (receiptSince === null) receiptSince = now();
          if (now() - receiptSince >= windows.receiptSettleMs) return end(ctl, "needs-wearer-check", "receipt", { reason: "observation_expired" });
        } else {
          return end(ctl, "needs-wearer-check", "receipt", { reason });
        }
      } else if (r.status === "awaiting-welcome") {
        if (!deps.welcome?.available?.()) return end(ctl, "welcome-unavailable", "welcome", { reason: "unavailable" });
        if (welcomeStartedAt === null) welcomeStartedAt = now();
        const remaining = windows.welcomeMs - (now() - welcomeStartedAt);
        if (remaining < 2000) return end(ctl, r.welcome?.attempts >= 2 ? "tries-exhausted" : "timed-out", "welcome");
        if (!phone) { await sleep(windows.tickMs, ctl.abort.signal); continue; }
        const input = { binding: firstUseBinding(r), installationId: r.installationId, timeoutMs: remaining,
          ...(r.welcome ? (retryWelcome ? { retry: true } : { auto: true }) : {}) };
        let failure      = null;
        try { await deps.welcome.run(input, ctl.abort.signal); }
        catch (error) { failure = error instanceof Error ? error.message : "render-failed"; }
        if (ctl.abort.signal.aborted) return;
        if (failure === "setup-welcome-surface-busy" || failure === "setup-welcome-already-waiting" ||
            PHONE_GONE_REASONS.includes(failure)) {

          const left = windows.welcomeMs - (now() - welcomeStartedAt);
          if (left < 2000) return end(ctl, "welcome-unavailable", "welcome", { reason: failure === "setup-welcome-surface-busy" ? "surface-busy" : "phone-disconnected" });
          await sleep(Math.max(windows.tickMs, 1000), ctl.abort.signal);
          continue;
        }
        if (failure === "setup-phone-binding-changed") return end(ctl, "phone-changed", "welcome");
        if (failure === "setup-welcome-retry-exhausted") return end(ctl, "tries-exhausted", "welcome");
        if (failure) {
          if (++autoRenders > windows.maxAutoRenders) return end(ctl, "welcome-unavailable", "welcome", { reason: "render-failed" });
          await sleep(windows.tickMs, ctl.abort.signal);
          continue;
        }
        retryWelcome = false;
        const after      = readRecord();
        const done = after.ok ? after.record : null;
        if (!done || done.attemptId !== ctl.attemptId) return;
        if (done.status === "completed") return end(ctl, "passed", "welcome");
        const reason = done.welcome?.reason ?? null;
        if (reason === "cancelled") return;
        if (reason === "timed-out") return end(ctl, done.welcome.attempts >= 2 ? "tries-exhausted" : "timed-out", "welcome");
        if (reason === "setup-phone-binding-changed") return end(ctl, "phone-changed", "welcome");

        if (++autoRenders > windows.maxAutoRenders) return end(ctl, "welcome-unavailable", "welcome", { reason: "render-failed" });
        log("first_use_relay_redraw", { reason: typeof reason === "string" ? reason : "unknown" });
        await sleep(windows.tickMs, ctl.abort.signal);
        continue;
      }
      await sleep(windows.tickMs, ctl.abort.signal);
    }
  }

  function stop(reason      = "stopped") {
    if (!run) return false;
    run.abort.abort();
    log("first_use_relay_stopped", { reason: typeof reason === "string" ? reason : "stopped" });
    run = null;
    return true;
  }

  const api      = {

    arm(options      = {}) {
      const read      = readRecord();
      const r = read.ok ? read.record : null;
      if (!r?.relayRun || r.relayRun.ending || r.status === "completed") return false;
      stopped = false;
      stop("rearmed");
      const ctl      = { attemptId: r.attemptId, abort: new AbortController(), retryWelcome: options.retryWelcome === true };
      run = ctl;
      log("first_use_relay_armed", { stage: stageOf(r), retryWelcome: ctl.retryWelcome });
      ctl.promise = track(drive(ctl)
        .catch((error     ) => log("first_use_relay_error", { error: error instanceof Error ? error.message : "error" }))
        .finally(() => { if (run === ctl) run = null; }));
      return true;
    },

    resume() {
      const read      = readRecord();
      const r = read.ok ? read.record : null;
      if (!r?.relayRun || r.relayRun.ending || r.status === "completed") return false;
      return api.arm();
    },
    stop,
    running() { return !!run; },

    isWakeRun(runId     ) { return typeof runId === "string" && wakeRunIds.has(runId); },
    noteSetupSession(session     ) {
      if (!session?.setupSessionKey) return;
      setupSession = { ...session, at: now() };
    },
    setupSession() { return setupSession; },

    pairingCompleted() {
      const session = setupSession;
      if (!session || now() - session.at > windows.setupSessionTtlMs) return false;
      const read      = readRecord();
      const r = read.ok ? read.record : null;
      if (r?.status === "completed" && r.confirmation?.source !== "test-input") return false;
      track((async () => {
        const deadline = now() + windows.pairedPhoneWaitMs;
        let connected = !!readPhone();
        while (!connected && !stopped && now() < deadline) {
          await sleep(500, null);
          connected = !!readPhone();
        }
        if (stopped) return;
        log("first_use_pairing_wake", { connected });
        await sendWake(session.setupSessionKey, buildFirstUseWakeMessage("phone-paired", { connected }), session.deliver === true, null);
      })());
      return true;
    },
    shutdown() { stopped = true; stop("shutdown"); },

    async idle() { while (background.size) await Promise.allSettled([...background]); },
  };
  return api;
}

module.exports = { createFirstUseRelayRun, buildFirstUseWakeMessage, firstUseSetupSessionFromContext, FIRST_USE_RELAY_ARM_LINES, FIRST_USE_RELAY_ARM_ACTION, FIRST_USE_RELAY_WELCOME_LINES, FIRST_USE_RELAY_REPLY_WINDOW_MS, FIRST_USE_RELAY_WELCOME_WINDOW_MS, FIRST_USE_RELAY_TICK_MS, FIRST_USE_RELAY_MAX_AUTO_RENDERS, FIRST_USE_RELAY_WAKE_RETRY_MS, FIRST_USE_RELAY_PAIRED_PHONE_WAIT_MS, FIRST_USE_RELAY_SETUP_SESSION_TTL_MS };
