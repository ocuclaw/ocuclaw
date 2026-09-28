const fs = require("node:fs/promises");
const { createSessionTitleDistiller } = require("./session-title-distiller.cjs");
const { stripAgentSessionPrefix } = require("./session-title-distiller-helpers.cjs");

function genRunId() {
  const c = globalThis && globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `ocuclaw-title-${c.randomUUID()}`;
  return `ocuclaw-title-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const HIDDEN_AGENT_FALLBACK_BEFORE = [2026, 8, 0];

function hostAllowsHiddenAgentFallback(hostVersion) {
  if (typeof hostVersion !== "string") return false;
  const match = hostVersion.trim().match(/^(\d{4})\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < HIDDEN_AGENT_FALLBACK_BEFORE.length; i += 1) {
    if (actual[i] < HIDDEN_AGENT_FALLBACK_BEFORE[i]) return true;
    if (actual[i] > HIDDEN_AGENT_FALLBACK_BEFORE[i]) return false;
  }
  return false;
}

function registerSessionTitleDistiller(api, service) {
  if (!api || typeof api.on !== "function") return () => {};

  const budget = {
    canRun: (k) => {
      const b = service.getDistillerBudget();
      return b ? b.canRun(k) : true;
    },
    recordTurn: (k) => {
      const b = service.getDistillerBudget();
      if (b) b.recordTurn(k);
    },
    recordOutcome: (k, o) => {
      const b = service.getDistillerBudget();
      if (b) b.recordOutcome(k, o);
    },
  };
  const distiller = createSessionTitleDistiller({

    getStateDir: () => (service.getStateDir ? service.getStateDir() : undefined),
    nowMs: () => Date.now(),
    genId: genRunId,
    emitDebug: (...a) => (service.emitDebug ? service.emitDebug(...a) : undefined),
    getSessionTitleModel: () =>
      typeof service.getSessionTitleModel === "function"
        ? service.getSessionTitleModel()
        : "",
    conversationState: { getRawMessages: () => service.getRawMessages() },
    sessionService: {
      getSessionTitleRecord: (k) => service.getSessionTitleRecord(k),
      isNeuralSessionNamesEnabled: (k) => service.isNeuralSessionNamesEnabled(k),
      isSessionUserLocked: (k) => service.isSessionUserLocked(k),
      hasRecordedUserMessage: (k) => service.hasRecordedUserMessage(k),
      setSessionTitle: (k, t, o) => service.setSessionTitle(k, t, o),
    },
    isEvenAiSessionKey: (k) => service.isEvenAiSessionKey(k),
    allowHiddenAgentFallback: hostAllowsHiddenAgentFallback(
      api && api.runtime ? api.runtime.version : undefined,
    ),
    isFirstUseAttemptOpen: () =>
      typeof service.isFirstUseAttemptOpen === "function"
        ? service.isFirstUseAttemptOpen()
        : false,
    cleanupDistillerSession: (k) =>
      typeof service.deleteDistillerSession === "function"
        ? service.deleteDistillerSession(k)
        : Promise.resolve(null),

    llmComplete: (() => {
      const llm = api && api.runtime && api.runtime.llm;
      if (!llm || typeof llm.complete !== "function") return undefined;
      return (params) => llm.complete(params);
    })(),
    subagentRuntime: (() => {
      const sa = api && api.runtime && api.runtime.subagent;
      if (
        !sa ||
        typeof sa.run !== "function" ||
        typeof sa.waitForRun !== "function" ||
        typeof sa.getSessionMessages !== "function" ||
        typeof sa.deleteSession !== "function"
      ) {
        return null;
      }
      return {
        run: (p) => sa.run(p),
        waitForRun: (p) => sa.waitForRun(p),
        getSessionMessages: (p) => sa.getSessionMessages(p),
        deleteSession: (p) => sa.deleteSession(p),
      };
    })(),
    gatewayBridge: {
      request: (m, p, o) => service.gatewayRequest(m, p, o),
      on: (evt, cb) => service.onGatewayEvent(evt, cb),
    },
    fs,
    budget,
  });

  return api.on("agent_end", (event, ctx) => {

    const rawSessionKey = ctx && typeof ctx.sessionKey === "string" ? ctx.sessionKey : null;
    const sessionKey = stripAgentSessionPrefix(rawSessionKey);
    if (!sessionKey) return;

    const eventMessages = event && Array.isArray(event.messages) ? event.messages : null;
    const messages =
      eventMessages && eventMessages.length
        ? eventMessages
        : service.getRawMessages();

    Promise.resolve(distiller.maybeRun(sessionKey, { messages })).catch(() => {});
  });
}

module.exports = { registerSessionTitleDistiller, hostAllowsHiddenAgentFallback };
