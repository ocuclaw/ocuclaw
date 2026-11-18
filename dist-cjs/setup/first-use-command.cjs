const { realpathSync } = require("node:fs");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const process = require("node:process");
const { setupInstallation, FIRST_USE_RETRY, firstUseSuccessLines, OPTIONAL_SETUP_HANDOFF_LINES } = require("./setup-journey.cjs");
const { resolveSetupStateDir } = require("./setup-controller.cjs");
const { createFirstUseStore, firstUseBinding, firstUseResult, FIRST_USE_WAIT_MAX_MS, FIRST_USE_RECEIPT_SETTLE_MAX_MS, FIRST_USE_TOOL_OPERATIONS, validateFirstUseParams } = require("./first-use.cjs");
const { terminalText } = require("./terminal-text.cjs");
const { awaitFirstUseReply, createGatewayFreezeRider, firstUseProviderErrorVerdict, firstUseTimeoutMessage, gatewayUnresponsiveMessage, isGatewayTransportFailure, isGatewayUnresponsive, GatewayUnresponsiveError, GATEWAY_UNRESPONSIVE_REASON, FIRST_USE_SEND_PROMPT, FIRST_USE_WAIT_PROMPT } = require("./first-use-wait.cjs");
const { firstUseSetupSessionFromContext } = require("./first-use-relay-run.cjs");

const FIRST_USE_DEFAULT_WAIT_MS = 600000;
const FIRST_USE_WAIT_POLL_MS = 3000;
const FIRST_USE_WAIT_NOTICE_MS = 30000;

const FIRST_USE_CANCELLED_BEFORE_REPLY_MESSAGE =
  "No phone message was received. Run openclaw ocuclaw first-use again when ready.";

function defaultSleep(ms     , signal      = null) {
  return new Promise      ((resolve) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener?.("abort", done, { once: true });
  });
}

const METHOD = "ocuclaw.setup.firstUse";

const SETUP_WELCOME_METHOD = "ocuclaw.setup.welcome";
const SETUP_WELCOME_OPERATIONS = Object.freeze(["first_use_welcome", "first_use_welcome_retry"]);
const SETUP_WELCOME_CANCEL_OPERATION = "first_use_welcome_cancel";

function registerSetupFirstUseControl(api     , service     ) {
  if (api?.registrationMode !== "full" || typeof api.registerGatewayMethod !== "function") return;
  api.registerGatewayMethod(METHOD, async ({ params, respond }     ) => {
    const installation = setupInstallation(resolveSetupStateDir(api));
    try {
      if (!installation.id || params?.installationId !== installation.id) throw new Error("installation-mismatch");
      const toolOperation = FIRST_USE_TOOL_OPERATIONS.includes(params.operation);
      if (!toolOperation && params.operation !== "begin") throw new Error("terminal-confirmation-required");
      if (toolOperation) {
        const { installationId, testInput, ...operationParams } = params;
        validateFirstUseParams(operationParams);
      }
      const relay = service.getRelay();
      if (typeof relay?.setupFirstUse !== "function") throw new Error("runtime-unavailable");
      const record = relay.setupFirstUse(params.operation, params);
      respond(true, { installation, record, testInput: params.testInput === true });
    } catch (error) {

      const reason = error instanceof Error && /^(setup-[a-z-]+|installation-mismatch|runtime-unavailable)$/.test(error.message) ? error.message : "setup-first-use-unavailable";
      respond(false, undefined, { code: "INVALID_REQUEST", message: `${reason}: Re-read journey; preserve existing setup state.` });
    }
  }, { scope: "operator.admin" });
}

function registerSetupWelcomeControl(api     , service     ) {
  if (api?.registrationMode !== "full" || typeof api.registerGatewayMethod !== "function") return;
  api.registerGatewayMethod(SETUP_WELCOME_METHOD, async ({ params, respond }     ) => {
    const installation = setupInstallation(resolveSetupStateDir(api));
    try {
      if (!installation.id || params?.installationId !== installation.id) throw new Error("installation-mismatch");
      const relay = service.getRelay();

      if (params.operation === SETUP_WELCOME_CANCEL_OPERATION) {
        if (typeof relay?.cancelSetupWelcome !== "function") throw new Error("runtime-unavailable");
        respond(true, { installation, cancelled: relay.cancelSetupWelcome() === true });
        return;
      }
      const { installationId, ...operationParams } = params;
      validateFirstUseParams(operationParams);
      if (!SETUP_WELCOME_OPERATIONS.includes(params.operation)) throw new Error("setup-welcome-operation-unsupported");
      if (typeof relay?.setupWelcome !== "function") throw new Error("runtime-unavailable");
      const record = await relay.setupWelcome({
        ...operationParams, installationId: installation.id,
        timeoutMs: operationParams.timeoutMs ?? FIRST_USE_WAIT_MAX_MS,
        retry: params.operation === "first_use_welcome_retry",
      }, null);
      respond(true, { installation, record });
    } catch (error) {

      const reason = error instanceof Error && /^(setup-[a-z-]+|installation-mismatch|runtime-unavailable)$/.test(error.message) ? error.message : "setup-welcome-unavailable";
      respond(false, undefined, { code: "INVALID_REQUEST", message: `${reason}: Re-read journey; preserve existing setup state.` });
    }
  }, { scope: "operator.admin" });
}

const FIRST_USE_UNAVAILABLE_ACTION = "Re-read journey. Check the owning runtime and intended phone session; preserve existing setup state.";

function firstUseUnavailable(error     ) {
  const reason = error instanceof Error ? /\b(setup-[a-z-]+|installation-mismatch|runtime-unavailable)(?:$|:)/.exec(error.message)?.[1] : null;
  return { status: "unavailable", reason: reason ?? "setup-first-use-unavailable", action: FIRST_USE_UNAVAILABLE_ACTION };
}

const FIRST_USE_CONFIRM_AFTER_WAKE_REASON =
  "setup-confirm-refused-after-wake: this turn was started by an OcuClaw setup notification, not by the wearer. Ask the wearer, end your turn, and record only their own reply.";
function createFirstUseWakeGuardHook(service     ) {
  return async function refuseConfirmFromWake(event     , ctx      = null) {
    if (event?.toolName !== "ocuclaw_setup" || event?.params?.operation !== "first_use_confirm") return undefined;
    const runId = typeof event?.runId === "string" && event.runId ? event.runId
      : typeof ctx?.runId === "string" && ctx.runId ? ctx.runId : null;
    if (!runId) return undefined;
    let woken = false;
    try { woken = service?.getRelay?.()?.isSetupWakeRun?.(runId) === true; } catch (_) { woken = false; }
    return woken ? { block: true, blockReason: FIRST_USE_CONFIRM_AFTER_WAKE_REASON } : undefined;
  };
}

function createFirstUseTool(api     , transport      = setupFirstUseRequest, service      = null, timing      = {}) {

  const clock = typeof timing?.now === "function" ? timing.now : () => Date.now();
  const pause = typeof timing?.sleep === "function" ? timing.sleep : null;
  return async (params     , signal      = null, ctx      = null) => {
    validateFirstUseParams(params);
    const installation = setupInstallation(resolveSetupStateDir(api));
    if (!installation.id) return { status: "unavailable", reason: "setup-state-unavailable" };

    const setupSession = firstUseSetupSessionFromContext(ctx);
    const relayNow = service?.getRelay?.();
    if (setupSession && typeof relayNow?.setupFirstUseRelay === "function" && relayNow.setupFirstUseRelayAvailable?.() === true) {
      try {
        return relayNow.setupFirstUseRelay(params.operation, { ...params, installationId: installation.id, setupSession });
      } catch (error) {
        return firstUseUnavailable(error);
      }
    }

    const waitMs = params.timeoutMs === undefined ? FIRST_USE_WAIT_MAX_MS
      : Math.max(0, params.timeoutMs - Math.min(1000, params.timeoutMs / 2));

    const deadline = clock() + waitMs;

    const projectWelcomeCapability = (result     ) => {
      if (!result?.nextOperations?.some((op        ) => op.startsWith("first_use_welcome"))) return result;
      if (service?.getRelay?.()?.setupWelcomeAvailable?.() === true) return result;
      return { ...result, nextOperations: [], welcome: { ...result.welcome, capability: "unavailable" } };
    };

    const cancelledBeforeRead = () => {
      try { return { ...projectWelcomeCapability(firstUseResult(createFirstUseStore(resolveSetupStateDir(api)).read())), wait: "cancelled" }; }
      catch (error) { return { status: "unavailable", reason: error instanceof Error ? error.message : "setup-first-use-unavailable", wait: "cancelled" }; }
    };
    let last      = null;

    let receiptSpent                = null;
    let receiptLastAt = 0;
    do {
      if (signal?.aborted) return last ? { ...projectWelcomeCapability(last), wait: "cancelled" } : cancelledBeforeRead();
      try {
        const relay = service?.getRelay?.();
        if (["first_use_welcome", "first_use_welcome_retry"].includes(params.operation)) {
          if (typeof relay?.setupWelcome !== "function") throw new Error("setup-welcome-unavailable");
          return await relay.setupWelcome({ ...params, installationId: installation.id,
            timeoutMs: waitMs, retry: params.operation === "first_use_welcome_retry" }, signal);
        } else if (params.operation === "first_use_wait") {

          if (typeof relay?.setupFirstUse !== "function") throw new Error("runtime-unavailable");
          last = relay.setupFirstUse(params.operation, { ...params, installationId: installation.id });
        } else {
          const result = await transport({ ...params, installationId: installation.id });
          if (result?.installation?.id !== installation.id || !result.record?.status) throw new Error("setup-context-mismatch");
          last = result.record;
        }
      } catch (error) {
        const reason = error instanceof Error ? /\b(setup-[a-z-]+|installation-mismatch|runtime-unavailable)(?:$|:)/.exec(error.message)?.[1] : null;
        return { status: "unavailable", reason: reason ?? "setup-first-use-unavailable",
          action: "Re-read journey. Check the owning runtime and intended phone session; preserve existing setup state." };
      }
      if (signal?.aborted) return { ...projectWelcomeCapability(last), wait: "cancelled" };
      if (params.operation !== "first_use_wait") return projectWelcomeCapability(last);

      if (last.status === "awaiting-confirmation" && last.replyEvidenceReason === "observation_pending") {
        const readAt = clock();
        if (receiptSpent === null) receiptSpent = 0;
        else receiptSpent += Math.min(Math.max(0, readAt - receiptLastAt), FIRST_USE_RECEIPT_GAP_MS);
        receiptLastAt = readAt;
        if (receiptSpent >= FIRST_USE_RECEIPT_SETTLE_MAX_MS) return projectWelcomeCapability(last);
      } else if (last.status !== "awaiting-reply") {
        return projectWelcomeCapability(last);
      } else if (last.replyRunErrored) {

        return projectWelcomeCapability(last);
      }
      if (clock() >= deadline) return { ...last, wait: "timed-out" };
      if (pause) { await pause(Math.min(250, Math.max(0, deadline - clock()))); continue; }

      await new Promise      (resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, Math.min(250, Math.max(0, deadline - clock())));
        signal?.addEventListener("abort", done, { once: true });
        if (signal?.aborted) done();
      });
    } while (true);
  };
}

async function callSetupGateway(method     , params     , timeoutMs     ) {
  const sdkName = "openclaw/plugin-sdk/gateway-runtime";
  const sdk = await import(sdkName).catch(() => {
    const hostRequire = createRequire(realpathSync(process.argv[1]));
    return import(pathToFileURL(hostRequire.resolve(sdkName)).href);
  });
  return sdk.callGatewayFromCli(method, { timeout: String(timeoutMs), json: true }, params,
    { scopes: ["operator.admin"], progress: false, clientName: "gateway-client", mode: "backend", deviceIdentity: null });
}

async function setupFirstUseRequest(params     ) {
  return callSetupGateway(METHOD, params, 12000);
}

const SETUP_WELCOME_SETTLE_MARGIN_MS = 15000;
const SETUP_WELCOME_TRANSPORT_MARGIN_MS = SETUP_WELCOME_SETTLE_MARGIN_MS + 15000;

async function setupWelcomeRequest(params     ) {
  const waitMs = params?.operation === SETUP_WELCOME_CANCEL_OPERATION ? 0
    : Number.isInteger(params?.timeoutMs) ? params.timeoutMs : FIRST_USE_WAIT_MAX_MS;
  return callSetupGateway(SETUP_WELCOME_METHOD, params, waitMs + SETUP_WELCOME_TRANSPORT_MARGIN_MS);
}

const SETUP_WELCOME_COMING_MESSAGE =
  "Double-tap the welcome on your glasses to finish.";
const SETUP_WELCOME_DONE_MESSAGE =
  "OcuClaw setup is complete for this OpenClaw installation.";
const SETUP_WELCOME_PHONE_MESSAGE =
  "Your phone is not connected to this server. The welcome could not be sent.\nOpen Even on your phone, then run the same command again.";
const SETUP_WELCOME_INCOMPLETE_MESSAGE =
  "The glasses welcome still needs a double-tap. Installation is done; setup is not complete.\nRun the same command again when you are ready.";

const SETUP_WELCOME_CANCELLED_MESSAGE =
  "Welcome check stopped.\nRun the same command again when you are ready.";
const SETUP_WELCOME_UNAVAILABLE_MESSAGE =
  "This host cannot show the glasses welcome right now.\nInstallation is done; the welcome double-tap is still pending.";

const FIRST_USE_TEST_INPUT_MESSAGE = "Test input exercised; no real wearer acceptance recorded.";

const WELCOME_PHONE_REASONS = ["setup-phone-session-ambiguous-or-disconnected",
  "setup-phone-session-unavailable", "setup-phone-binding-changed"];

async function runSetupWelcome(api     , options      = {}, io      = {}) {
  const output = io.output ?? process.stdout;
  const request = io.request ?? setupWelcomeRequest;
  const installation = setupInstallation(resolveSetupStateDir(api));
  const binding = options.binding;
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : FIRST_USE_WAIT_MAX_MS;
  if (!installation.id || typeof binding !== "string" || !/^[a-f0-9]{64}$/.test(binding)) {
    output.write(`${SETUP_WELCOME_UNAVAILABLE_MESSAGE}\n`);
    return { ok: false, outcome: "unavailable", reason: "setup-welcome-binding-unavailable", record: null };
  }
  output.write(`${terminalText(SETUP_WELCOME_COMING_MESSAGE, "action", output, io.env)}\n`);
  let cancelling = false;
  const cancel = () => {
    if (cancelling) return;
    cancelling = true;

    Promise.resolve(request({ installationId: installation.id, operation: SETUP_WELCOME_CANCEL_OPERATION }))
      .catch(() => {  });
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  options.signal?.addEventListener?.("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();

  let operation = options.retry === true ? "first_use_welcome_retry" : "first_use_welcome";
  let resent = false;
  const rider = createGatewayFreezeRider({
    now: io.now, sleep: io.sleep ?? defaultSleep,
    say: (text     ) => output.write(`${text}\n`),
    cancelled: () => cancelling,
  });
  try {
    const result      = await rider.call(async () => {
      try {
        return await request({ installationId: installation.id, binding, timeoutMs, operation });
      } catch (error) {
        if (isGatewayTransportFailure(error)) { operation = "first_use_welcome_retry"; resent = true; }
        throw error;
      }
    }, { retryable: (error     ) => isGatewayTransportFailure(error) ||
      (resent && /\bsetup-welcome-already-waiting\b/.test(String(error?.message ?? ""))) });
    const record = result?.record ?? null;
    if (result?.installation?.id !== installation.id || !record?.status) {
      return { ok: false, outcome: "unavailable", reason: "setup-context-mismatch", record: null };
    }
    if (record.status === "completed") {
      output.write(`${SETUP_WELCOME_DONE_MESSAGE}\n`);
      for (const line of OPTIONAL_SETUP_HANDOFF_LINES) output.write(`${line}\n`);
      return { ok: true, outcome: "dismissed", reason: null, record };
    }

    if (record.welcome?.status === "completed" && record.acceptance === "test-input-only") {
      output.write(`${FIRST_USE_TEST_INPUT_MESSAGE}\n`);
      return { ok: true, outcome: "dismissed", reason: null, record };
    }
    const reason = record.welcome?.reason ?? null;
    if (cancelling || reason === "cancelled") {
      output.write(`${SETUP_WELCOME_CANCELLED_MESSAGE}\n`);
      return { ok: false, outcome: "cancelled", reason, record };
    }
    if (WELCOME_PHONE_REASONS.includes(reason)) {
      output.write(`${SETUP_WELCOME_PHONE_MESSAGE}\n`);
      return { ok: false, outcome: "phone-disconnected", reason, record };
    }
    output.write(`${SETUP_WELCOME_INCOMPLETE_MESSAGE}\n`);
    return { ok: false, outcome: "incomplete", reason, record };
  } catch (error     ) {
    const message = error?.message ? String(error.message) : String(error ?? "");
    const reason = /\b(setup-[a-z-]+|installation-mismatch|runtime-unavailable)\b/.exec(message)?.[1] ?? "setup-welcome-unavailable";
    if (isGatewayUnresponsive(error) && !cancelling) {
      output.write(`${gatewayUnresponsiveMessage(error.waitedMs)}\n`);
      return { ok: false, outcome: GATEWAY_UNRESPONSIVE_REASON, reason: GATEWAY_UNRESPONSIVE_REASON, record: null };
    }
    if (cancelling) {
      output.write(`${SETUP_WELCOME_CANCELLED_MESSAGE}\n`);
      return { ok: false, outcome: "cancelled", reason, record: null };
    }
    if (WELCOME_PHONE_REASONS.includes(reason)) {
      output.write(`${SETUP_WELCOME_PHONE_MESSAGE}\n`);
      return { ok: false, outcome: "phone-disconnected", reason, record: null };
    }
    output.write(`${SETUP_WELCOME_UNAVAILABLE_MESSAGE}\n`);
    return { ok: false, outcome: "unavailable", reason, record: null };
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    options.signal?.removeEventListener?.("abort", cancel);
  }
}

const FIRST_USE_RECEIPT_MESSAGE =
  "Your phone reported SDK acceptance of the reply.";

const FIRST_USE_RETRY_CHECKING_MESSAGE = "Checking the first message again…";

const FIRST_USE_RECEIPT_STALL_MAX_MS = 120000;

const FIRST_USE_RECEIPT_GAP_MS = 3000;
const FIRST_USE_RECEIPT_STALL_MESSAGE =
  "The gateway is slow to answer. Still waiting for the phone's receipt...";

const FIRST_USE_REPLY_GOT_MESSAGE = "Your phone got the reply.";

const FIRST_USE_SEEN_PROMPT = "Did the reply appear on your Even G2? [yes/no]: ";

const FIRST_USE_SEEN_ANSWER = "SEEN ON G2";

function seenOnG2Typed(typed     )          {
  return String(typed ?? "").trim().toLowerCase() === "yes";
}

function notSeenOnG2Typed(typed     )          {
  return String(typed ?? "").trim().toLowerCase() === "no";
}

const FIRST_USE_SIMULATOR_MESSAGE =
  "This was the simulator, so setup can't check the glasses itself.";
const FIRST_USE_SIMULATOR_REASON = "simulator_lane_not_eligible";

const FIRST_USE_NOT_CONFIRMED_LINES = [
  "Nothing was recorded, because the reply was not confirmed on your Even G2.",
  "Run `openclaw ocuclaw first-use --retry` if the reply never appears.",
];

function createFirstUseCommand(api     ) {
  return async function firstUse(options      = {}, io      = {}) {
    const input = io.input ?? process.stdin;
    const output = io.output ?? process.stdout;
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
      output.write("First-use confirmation requires your own interactive terminal. Piped input cannot confirm G2.\n");
      return { exitCode: 2 };
    }

    const relayedKeys = !!io.input && io.input.speckLook === true;
    const testInput = options.testInput === true || !!((io.input && !relayedKeys) || io.request);
    const installation = setupInstallation(resolveSetupStateDir(api));

    const rawCall = (params     ) => (io.request ?? setupFirstUseRequest)({ ...params, installationId: installation.id, testInput });
    const call = (params     ) => rider.call(() => rawCall(params));
    let armed = false;
    let answer = "";
    let cancelled = false;
    let finish     ;
    const decision = new Promise        ((resolve) => { finish = resolve; });

    const welcomeAbort = new AbortController();
    const stop = () => { cancelled = true; welcomeAbort.abort(); finish(""); };

    const cancellableSleep = (ms        ) => new Promise      ((resolve) => {
      const done = () => { clearTimeout(pause); input.off("data", onCancelPoll); resolve(); };
      const onCancelPoll = () => { if (cancelled) done(); };
      const pause = setTimeout(done, ms);
      input.on("data", onCancelPoll);
    });
    const rider = createGatewayFreezeRider({
      now: io.now, sleep: io.sleep ?? cancellableSleep,
      say: (text     ) => output.write(`${text}\n`),
      cancelled: () => cancelled,
    });
    const showWelcome = async () => {

      clearTimeout(timer);
      let stored      = null;
      try { stored = createFirstUseStore(resolveSetupStateDir(api)).read(); } catch (_) { stored = null; }
      const run = io.welcome ?? runSetupWelcome;
      const result = await run(api, { binding: firstUseBinding(stored), retry: !!stored?.welcome,
        signal: welcomeAbort.signal }, { output, request: io.welcomeRequest, now: io.now, sleep: io.sleep });
      if (result?.outcome === GATEWAY_UNRESPONSIVE_REASON) return { exitCode: 1, gatewayUnresponsive: true };
      return { exitCode: result?.ok === true ? 0 : 1 };
    };
    const onData = (chunk     ) => {
      for (const char of String(chunk)) {
        if (["\u0003", "\u0004", "\u001b"].includes(char)) { stop(); return; }
        if (!armed) continue;
        if (char === "\r" || char === "\n") { armed = false; finish(answer); }
        else if (char === "\u007f" || char === "\b") {
          if (answer.length) { answer = answer.slice(0, -1); output.write("\b \b"); }
        }
        else if (/^[A-Za-z0-9 ]$/.test(char) && answer.length < 32) { answer += char; output.write(char); }
        else { armed = false; finish(""); }
      }
    };
    const wasRaw = input.isRaw;
    const wasPaused = input.isPaused();
    let timer     ;
    input.on("data", onData);
    input.on("end", stop);
    input.on("close", stop);
    input.on("error", stop);
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      input.setRawMode(true);
      input.resume();
      if (options.retry === true) output.write(`${FIRST_USE_RETRY_CHECKING_MESSAGE}\n`);
      const result = await call({ operation: "begin", sessionKey: options.session, retry: options.retry === true });
      let r = result?.record;
      if (result?.installation?.id !== installation.id || !r || r.installationId !== installation.id) throw new Error("context-mismatch");
      if (r.status === "completed" && r.confirmation?.source !== "test-input") { output.write(`${firstUseSuccessLines(r).join("\n")}\n`); return { exitCode: 0 }; }
      if (r.status === "awaiting-welcome") {
        if (r.replyEvidence === "client_sdk_receipt") output.write(`${FIRST_USE_RECEIPT_MESSAGE}\n`);
        return await showWelcome();
      }

      output.write(terminalText("OpenClaw first reply\n", "heading", output, io.env));
      if (r.status === "awaiting-reply") {

        if (options.waitForReply === false) { output.write(`${FIRST_USE_RETRY}\n`); return { exitCode: 0 }; }
        const waitMs = Number.isInteger(options.waitMs) ? options.waitMs : FIRST_USE_DEFAULT_WAIT_MS;

        let lastWaitRunErrored      = null;

        let lostGateway      = null;
        output.write(`${terminalText(FIRST_USE_SEND_PROMPT, "action", output, io.env)}\n`);
        output.write(`${FIRST_USE_WAIT_PROMPT}\n`);
        const waited      = await awaitFirstUseReply({
          call: async (params     ) => {
            try {
              const res      = await call(params);
              if (res?.installation?.id !== installation.id) return { ok: false, reason: "setup-context-mismatch" };
              if (res?.record?.replyRunErrored) lastWaitRunErrored = res.record.replyRunErrored;
              return { ok: true, record: res?.record ?? null };
            } catch (error     ) {
              if (isGatewayUnresponsive(error)) { lostGateway = error; return { ok: false, reason: GATEWAY_UNRESPONSIVE_REASON }; }
              const message = error?.message ? String(error.message) : String(error ?? "");
              return { ok: false, reason: /\b(setup-[a-z-]+)\b/.exec(message)?.[1] ?? "setup-first-use-unavailable" };
            }
          },
          say: (text     ) => output.write(`${text}\n`),
          now: io.now ?? (() => Date.now()),
          sleep: io.sleep ?? defaultSleep,

          signal: welcomeAbort.signal,
          waitMs,
          pollMs: Number.isInteger(io.pollMs) ? io.pollMs : FIRST_USE_WAIT_POLL_MS,
          noticeMs: Number.isInteger(io.noticeMs) ? io.noticeMs : FIRST_USE_WAIT_NOTICE_MS,
          initialStatus: r.status,
        });
        if (waited.outcome === "cancelled") {
          output.write(`\n${FIRST_USE_CANCELLED_BEFORE_REPLY_MESSAGE}\n`);
          return { exitCode: 1 };
        }
        if (waited.outcome === "unavailable" && waited.reason === GATEWAY_UNRESPONSIVE_REASON) {
          throw lostGateway ?? new GatewayUnresponsiveError(0);
        }

        if (waited.outcome === "errored") {
          output.write(`${firstUseProviderErrorVerdict(waited.record?.replyRunErrored ?? waited.reason)}\n`);
          return { exitCode: 1 };
        }
        if (waited.outcome === "timeout") {

          const errored = waited.record?.replyRunErrored ?? lastWaitRunErrored;
          output.write(`${errored
            ? firstUseProviderErrorVerdict(errored)
            : firstUseTimeoutMessage(waitMs)}\n`);
          return { exitCode: 1 };
        }
        if (waited.outcome !== "replied" || !waited.record) throw new Error("reply-required");
        r = waited.record;
        if (r.status === "completed" && r.confirmation?.source !== "test-input") { output.write(`${firstUseSuccessLines(r).join("\n")}\n`); return { exitCode: 0 }; }
        if (r.status === "awaiting-welcome") {
          if (r.replyEvidence === "client_sdk_receipt") output.write(`${FIRST_USE_RECEIPT_MESSAGE}\n`);
          return await showWelcome();
        }
      }
      if ((r.status !== "awaiting-confirmation" && r.confirmation?.source !== "test-input") || !r.reply?.runId || !r.attemptId) throw new Error("reply-required");

      let simulatorReply = r.replyEvidenceReason === FIRST_USE_SIMULATOR_REASON;
      if (r.status === "awaiting-confirmation") {

        const settleNow = io.now ?? (() => Date.now());

        const settleStart = settleNow();
        const stallBy = settleStart + FIRST_USE_RECEIPT_STALL_MAX_MS;
        let lastAnswerAt = settleStart;
        let spent = 0;
        let stallSaid = false;
        for (;;) {
          const observed      = await rawCall({ operation: "first_use_wait" }).catch(() => null);
          const seen = observed?.record;
          if (!seen) {
            if (cancelled) break;

            if (!stallSaid) { stallSaid = true; if (!rider.said) { rider.said = true; output.write(`${FIRST_USE_RECEIPT_STALL_MESSAGE}\n`); } }
            if (settleNow() >= stallBy) break;
            if (io.sleep) { await io.sleep(1000); continue; }
            await cancellableSleep(1000);
            continue;
          }
          if (seen.replyEvidenceReason === FIRST_USE_SIMULATOR_REASON) simulatorReply = true;
          const answeredAt = settleNow();
          spent += Math.min(answeredAt - lastAnswerAt, FIRST_USE_RECEIPT_GAP_MS);
          lastAnswerAt = answeredAt;
          if (seen?.status === "awaiting-welcome" && seen.replyEvidence === "client_sdk_receipt") {
            output.write(`${FIRST_USE_RECEIPT_MESSAGE}\n`);
            return await showWelcome();
          }

          if (seen?.replyWasProviderError === true) {
            output.write(`${firstUseProviderErrorVerdict(seen.replyRunErrored ?? seen.replyEvidenceReason)}\n`);
            return { exitCode: 1 };
          }
          if (cancelled) break;
          if (seen?.status !== "awaiting-confirmation" ||
              seen.replyEvidenceReason !== "observation_pending") break;
          if (spent >= FIRST_USE_RECEIPT_SETTLE_MAX_MS || settleNow() >= stallBy) break;
          if (io.sleep) { await io.sleep(200); continue; }
          await cancellableSleep(200);
        }
      }

      if (options.waitForReply !== false) output.write(terminalText(`${FIRST_USE_REPLY_GOT_MESSAGE}\n`, "detail", output, io.env));

      if (simulatorReply) output.write(terminalText(`${FIRST_USE_SIMULATOR_MESSAGE}\n`, "detail", output, io.env));
      output.write("If it never appeared, cancel and run openclaw ocuclaw first-use --retry\nbefore sending a fresh phone message.\n\n");
      output.write(terminalText("Enter alone or Ctrl-C leaves setup unfinished.\n", "detail", output, io.env));
      output.write(terminalText(FIRST_USE_SEEN_PROMPT, "action", output, io.env));

      await new Promise((resolve) => setTimeout(resolve, 0));
      if (!cancelled) armed = true;
      timer = setTimeout(stop, io.timeoutMs ?? 120000);
      const typed = await decision;
      if (notSeenOnG2Typed(typed) && !cancelled) {
        output.write(`\n${FIRST_USE_NOT_CONFIRMED_LINES.join("\n")}\n`);
        return { exitCode: 1 };
      }
      if (!seenOnG2Typed(typed) || cancelled) {
        output.write("\nG2 confirmation is still pending. Run openclaw ocuclaw first-use when ready; no need to pair again.\n");
        return { exitCode: 1 };
      }
      const confirmed = createFirstUseStore(resolveSetupStateDir(api)).confirm({
        installationId: installation.id, attemptId: r.attemptId, testInput,
        sessionKey: r.sessionKey, runId: r.reply.runId, source: "direct-wearer-terminal", answer: FIRST_USE_SEEN_ANSWER });
      if (testInput) {
        output.write(`\n${FIRST_USE_TEST_INPUT_MESSAGE}\n`);
        return { exitCode: 0, testInput: true };
      }
      if (confirmed?.status === "awaiting-welcome" && confirmed.attemptId === r.attemptId) {
        output.write("\n");
        return await showWelcome();
      }
      if (confirmed?.status !== "completed" || confirmed.attemptId !== r.attemptId) throw new Error("completion-unverified");
      output.write(`\n${firstUseSuccessLines(confirmed).join("\n")}\n`);
      return { exitCode: 0 };
    } catch (error     ) {

      if (isGatewayUnresponsive(error)) {
        output.write(`\n${gatewayUnresponsiveMessage(error?.waitedMs)}\n`);
        return { exitCode: 1, gatewayUnresponsive: true };
      }
      if (cancelled && isGatewayTransportFailure(error)) {
        output.write("\nG2 confirmation is still pending. Run openclaw ocuclaw first-use when ready; no need to pair again.\n");
        return { exitCode: 1 };
      }
      output.write("\nFirst-use state could not be verified.\nRun openclaw ocuclaw journey for this installation and retry.\nPreserve existing credentials and checkpoint files.\n");
      return { exitCode: 2 };
    } finally {
      clearTimeout(timer);
      input.removeListener("data", onData);
      input.removeListener("end", stop);
      input.removeListener("close", stop);
      input.removeListener("error", stop);
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    }
  };
}

module.exports = { FIRST_USE_DEFAULT_WAIT_MS, FIRST_USE_WAIT_POLL_MS, FIRST_USE_WAIT_NOTICE_MS, FIRST_USE_CANCELLED_BEFORE_REPLY_MESSAGE, SETUP_WELCOME_METHOD, SETUP_WELCOME_OPERATIONS, SETUP_WELCOME_CANCEL_OPERATION, registerSetupFirstUseControl, registerSetupWelcomeControl, FIRST_USE_CONFIRM_AFTER_WAKE_REASON, createFirstUseWakeGuardHook, createFirstUseTool, setupFirstUseRequest, SETUP_WELCOME_SETTLE_MARGIN_MS, SETUP_WELCOME_TRANSPORT_MARGIN_MS, setupWelcomeRequest, SETUP_WELCOME_COMING_MESSAGE, SETUP_WELCOME_DONE_MESSAGE, SETUP_WELCOME_PHONE_MESSAGE, SETUP_WELCOME_INCOMPLETE_MESSAGE, SETUP_WELCOME_CANCELLED_MESSAGE, SETUP_WELCOME_UNAVAILABLE_MESSAGE, runSetupWelcome, FIRST_USE_RECEIPT_MESSAGE, FIRST_USE_RETRY_CHECKING_MESSAGE, FIRST_USE_RECEIPT_STALL_MAX_MS, FIRST_USE_RECEIPT_GAP_MS, FIRST_USE_RECEIPT_STALL_MESSAGE, FIRST_USE_REPLY_GOT_MESSAGE, FIRST_USE_SEEN_PROMPT, FIRST_USE_SEEN_ANSWER, seenOnG2Typed, notSeenOnG2Typed, FIRST_USE_SIMULATOR_MESSAGE, FIRST_USE_SIMULATOR_REASON, FIRST_USE_NOT_CONFIRMED_LINES, createFirstUseCommand };
