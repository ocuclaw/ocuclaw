const { isCloudwaysManagedHost } = require("./cloudways-host.cjs");
const { firstUseResult, sameFirstUsePhone } = require("./first-use.cjs");
const { openClawWelcomeSurface } = require("./welcome-surface.cjs");

const SETUP_WELCOME_DISCONNECT_GRACE_MS = 15000;
const PHONE_GONE_REASONS = ["setup-phone-session-ambiguous-or-disconnected", "setup-phone-session-unavailable"];

function createSetupWelcome(store     , readPhone     , getRenderer     ,
  isCloudways      = isCloudwaysManagedHost, awaitReplySettled      = null, options      = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const graceMs = Number.isFinite(options.disconnectGraceMs) ? options.disconnectGraceMs : SETUP_WELCOME_DISCONNECT_GRACE_MS;
  let active      = null;

  let waiting      = null;

  function checkPhone(record     ) {
    if (!record) throw new Error("setup-attempt-required");
    const phone = readPhone();
    if (phone.sessionKey !== record.sessionKey || !sameFirstUsePhone(record.phone, phone)) {
      throw new Error("setup-phone-binding-changed");
    }
    return phone;
  }

  return {
    available() { return !!getRenderer(); },
    admitOutcome(frame     ) {
      if (!active || frame?.surfaceId !== active.surfaceId) return true;

      if (!active.renderer.isCurrentDeclaration(active.surfaceId, active.declarationId)) return true;

      let current      = null;
      try { current = checkPhone(active.record); } catch (_) { return false; }
      if (frame.clientId !== current.clientId || frame.phoneClient !== true ||
          !["dismissed", "back"].includes(frame.outcome?.result) ||
          (frame.outcome.origin !== undefined && frame.outcome.origin !== "gesture") ||
          (frame.outcome.actor !== undefined && frame.outcome.actor !== "wearer")) return false;
      active.gesture = frame.outcome.result;
      return true;
    },

    busy() { return !!(active || waiting); },

    cancel(reason      = "runtime-unavailable") {

      if (waiting) { waiting.reason = reason; waiting.abort.abort(); return true; }
      if (!active) return false;
      active.reason = reason;
      active.abort.abort();
      return true;
    },
    async run(input     , signal      = null) {
      if (active || waiting) throw new Error("setup-welcome-already-waiting");
      if (signal?.aborted) return { ...firstUseResult(store.read()), wait: "cancelled" };
      const renderer = getRenderer();
      if (!renderer) throw new Error("setup-welcome-unavailable");
      let current = store.read();
      if (current?.status === "completed") return firstUseResult(store.beginWelcome(input));
      let phone = checkPhone(current);

      if (typeof awaitReplySettled === "function") {
        const gate      = { abort: new AbortController(), reason: null };
        const relay = () => gate.abort.abort();
        waiting = gate;
        signal?.addEventListener?.("abort", relay, { once: true });
        try { await awaitReplySettled(current?.reply?.runId ?? null, gate.abort.signal); }
        finally { signal?.removeEventListener?.("abort", relay); waiting = null; }
        if (signal?.aborted || gate.abort.signal.aborted) {
          return { ...firstUseResult(store.read()), wait: "cancelled" };
        }

        current = store.read();
        phone = checkPhone(current);
      }
      if (renderer.surfaceStackDepth(current.sessionKey) > 0) throw new Error("setup-welcome-surface-busy");
      const record = store.beginWelcome({ ...input, phone });
      const pending      = { record, phone, renderer, surfaceId: undefined, declarationId: undefined, recorded: {},
        gesture: null, abort: new AbortController(), reason: null };
      active = pending;
      const cancel = () => { pending.reason = "cancelled"; pending.abort.abort(); };
      signal?.addEventListener("abort", cancel, { once: true });
      let goneSince      = null;
      const monitor = setInterval(() => {
        try { checkPhone(record); goneSince = null; }
        catch (error) {
          const reason = error instanceof Error ? error.message : "runtime-unavailable";

          if (PHONE_GONE_REASONS.includes(reason) && graceMs > 0) {
            if (goneSince === null) goneSince = now();
            if (now() - goneSince < graceMs) return;
          }
          pending.reason = reason;
          pending.abort.abort();
        }
      }, 100);
      try {
        if (signal?.aborted) cancel();
        const surface = openClawWelcomeSurface(isCloudways());
        const outcome = await renderer.runDynamicUi({
          sessionKey: record.sessionKey, depth: 1, signal: pending.abort.signal,
          settleOnSupersede: true,
          spec: { ...surface, timeoutMs: input.timeoutMs ?? surface.timeoutMs },
          onOpened({ surfaceId, declarationId }     ) {
            pending.surfaceId = surfaceId;
            pending.declarationId = declarationId;

            try { store.welcomeOpened(record.welcome.id, surfaceId, declarationId); pending.recorded = { surfaceId, declarationId }; }
            catch (_) { pending.reason = "setup-state-locked"; pending.abort.abort(); }
          },
        });

        try { checkPhone(record); }
        catch (error) { if (!(error instanceof Error) || !PHONE_GONE_REASONS.includes(error.message)) throw error; }
        const dismissed = pending.gesture && outcome?.result === pending.gesture && !pending.reason;
        const reason = pending.reason ?? (dismissed ? null : outcome?.reason === "superseded" ? "render-replaced"
          : outcome?.result === "window_expired" ? "timed-out"
          : outcome?.result === "render_failed" ? "render-failed" : "dismissal-unconfirmed");
        return { ...firstUseResult(store.finishWelcome({ id: record.welcome.id, ...pending.recorded, phone,
          outcome: dismissed ? pending.gesture : null, reason })),
          conversationReturn: "requires-native-or-wearer-check" };
      } catch (error) {
        const reason = pending.reason ?? (error instanceof Error && /^setup-[a-z-]+$/.test(error.message) ? error.message : "render-failed");
        return firstUseResult(store.finishWelcome({ id: record.welcome.id, ...pending.recorded, phone, reason }));
      } finally {
        clearInterval(monitor);
        signal?.removeEventListener("abort", cancel);
        pending.abort.abort();

        if (pending.surfaceId && renderer.sessionForSurface(pending.surfaceId) === record.sessionKey) {
          renderer.releaseLibraryTemplateSurface(pending.surfaceId, { result: "preempted", origin: "system" }, pending.declarationId);
        }
        active = null;
      }
    },
  };
}

module.exports = { createSetupWelcome, SETUP_WELCOME_DISCONNECT_GRACE_MS };
