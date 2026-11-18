const { getActiveBackendKind } = require("../gateway/backend-contract.cjs");
const { HERMES_DEFAULT_PROFILE } = require("./hermes-enrollment.cjs");
const { isSupersededSessionSwitchError } = require("./session-service.cjs");

function createRelaySessionHandlers(ctx                             ) {
  const {
    sessionService,
    broadcastSessions,
    hermesEnrollment,
    stablePromptSnapshots,
    logger,
    simulation,
    conversationState,
    switchToSessionAndRunPostSwitchFlow,
    mintAgentRefs,
    emitDebug,
    clearCurrentSessionModelConfigSnapshot,
    seedOcuClawSessionConfigForNewSession,
    adoptActiveSessionModelConfig,
    resetActivityStatusAdapter,
    clearLogicalSessionState,
    cachePages,
    openclawGatewayKeyFor,
    gatewayBridge,
    applyNewChatReasoningDefault,
    broadcastEntriesForActiveLedgerClients,
    sessionDriverWatch,
    getCapabilityAgentCatalogSnapshot,
    setPathwayBinding,
    noteAppClientSessionSelected,
    taskResultProposals,
    agentDrafts,
    taskFromWords,
    taskPresentations,
    programCardBindingsSnapshot,
    buildEvenAiSessionsSnapshot,
  } = ctx;

  return {
    async onSetUserSessionTitle(sessionKey     , title     ) {
      const result = await sessionService.setUserSessionTitle(sessionKey, title);
      if (result && result.ok) {
        await broadcastSessions();
      }
      return result;
    },

    onSetSessionPinned(sessionKey     , pinned     , kind     ) {
      const result = sessionService.setSessionPinned(kind, sessionKey, pinned);
      if (result && result.ok) {
        broadcastSessions();
      }
      return result;
    },

    async onSetSessionHidden(sessionKey     , hidden     ) {
      const result = await sessionService.setSessionHidden(sessionKey, hidden);
      if (result && result.ok) {

        await broadcastSessions();
      }
      return result;
    },

    async onMarkAllSessionsRead() {
      const result      = await sessionService.markAllSessionsRead();
      if (result && result.ok && result.marked > 0) {

        await broadcastSessions();
      }
      return result;
    },

    onCompactSession({ sessionKey }     ) {
      if (!ctx.upstreamRuntime || typeof ctx.upstreamRuntime.compactActiveSession !== "function") {
        return Promise.resolve({
          status: "rejected",
          error: "upstream runtime not ready",
        });
      }
      return ctx.upstreamRuntime.compactActiveSession(sessionKey);
    },

    onDeleteSessions(sessionKeys     , kind     , switchBeforeDelete     ) {
      if (Array.isArray(sessionKeys)) {
        for (const key of sessionKeys) {
          if (typeof key === "string" && key.trim()) {
            stablePromptSnapshots.evict(key);
            sessionService.clearDisplayToggleStates(key);
          }
        }
      }
      const action = switchBeforeDelete
        ? sessionService.switchAndDeleteSessions(kind, sessionKeys)
        : sessionService.deleteSessions(kind, sessionKeys);
      Promise.resolve(action)
        .then(() => broadcastSessions())
        .catch((err) => {
          logger.error(`[relay] deleteSessions failed: ${err && err.message ? err.message : err}`);
        });
    },

    onSearchTranscripts(clientId     , query     , kind     , requestId     ) {
      const sendSearchResult = (result     ) => {
        if (!ctx.server) return;
        const payload = {
          type: "ocuclaw.session.transcripts.search.result",
          ...(requestId ? { requestId } : {}),
          query,
          kind,
          snippets: result && Array.isArray(result.snippets) ? result.snippets : [],
          truncated: !!(result && result.truncated),
          refreshing: !!(result && result.refreshing),
          unavailable: !!(result && result.unavailable),
          unavailableReason:
            result && typeof result.unavailableReason === "string"
              ? result.unavailableReason
              : null,
        };
        ctx.server.unicast(clientId, JSON.stringify(payload));
      };
      Promise.resolve().then(() => sessionService.searchTranscripts(kind, query))
        .then((result) => {
          sendSearchResult(result);
          if (result && result.refreshPromise && typeof result.refreshPromise.then === "function") {
            result.refreshPromise
              .then(() => sessionService.searchTranscripts(kind, query, { skipRefresh: true }))
              .then((freshResult     ) => sendSearchResult({ ...freshResult, refreshing: false }))
              .catch((err     ) => {
                logger.error(`[relay] transcript refresh failed: ${err && err.message ? err.message : err}`);
                sendSearchResult({
                  snippets: result.snippets || [], truncated: !!result.truncated, refreshing: false,
                  unavailable: true, unavailableReason: "search_refresh_failed",
                });
              });
          }
        })
        .catch((err) => {
          logger.error(`[relay] searchTranscripts failed: ${err && err.message ? err.message : err}`);
          sendSearchResult({
            snippets: [], truncated: false, refreshing: false,
            unavailable: true, unavailableReason: "search_failed",
          });
        });
    },

    onNewChat() {
      emitDebug(
        "relay.session",
        "new_chat",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({}),
      );
      if (ctx.upstreamRuntime && typeof ctx.upstreamRuntime.clearTyping === "function") {
        ctx.upstreamRuntime.clearTyping("new_chat");
      }
      if (getActiveBackendKind() === "hermes") {
        simulation.clearSyntheticWorkForSession(sessionService.ensureSessionKey());
        return sessionService.newSession({
          sendResetCommand: false,
          materializeImmediately: false,
        }).then(async (result     ) => {
          stablePromptSnapshots.evict(result.sessionKey);
          sessionService.clearDisplayToggleStates(result.sessionKey);
          clearCurrentSessionModelConfigSnapshot("new_chat");
          if (ctx.upstreamRuntime && typeof ctx.upstreamRuntime.handleSessionChanged === "function") {
            ctx.upstreamRuntime.handleSessionChanged("new_chat");
          }
          const sessionModelConfig = await seedOcuClawSessionConfigForNewSession(
            result.sessionKey,
          );
          return {
            ...result,
            draft: true,
            ...(sessionModelConfig ? { sessionModelConfig } : {}),
          };
        });
      }
      sessionService.invalidateSessionsCache();
      resetActivityStatusAdapter();

      simulation.clearSyntheticWorkForSession(sessionService.ensureSessionKey());
      conversationState.clear(sessionService.ensureSessionKey(), true);

      const newChatSessionKey = sessionService.ensureSessionKey();
      stablePromptSnapshots.evict(newChatSessionKey);
      clearLogicalSessionState(newChatSessionKey, "new_chat");
      conversationState.setAgentName(
        (ctx.upstreamRuntime ? ctx.upstreamRuntime.getAgentName() : null) || "Agent",
      );
      const pages = conversationState.getPages();
      cachePages(pages);
      let resetPromise = Promise.resolve();
      if (ctx.upstreamRuntime && ctx.upstreamRuntime.isConnected()) {
        const resetGatewaySession = openclawGatewayKeyFor(newChatSessionKey);

        resetPromise = gatewayBridge
          .sendMessage(
            "/new",
            newChatSessionKey,
            null,
            resetGatewaySession.agentId
              ? { agentId: resetGatewaySession.agentId }
              : undefined,
          )
          .catch((err     ) => {
            logger.error(`[relay] Failed to send /new: ${err.message}`);
          });
      }
      return resetPromise.then(() => {

        void applyNewChatReasoningDefault(newChatSessionKey);

        broadcastEntriesForActiveLedgerClients("new_chat");

        if (ctx.upstreamRuntime && typeof ctx.upstreamRuntime.refreshSessionContext === "function") {
          ctx.upstreamRuntime.refreshSessionContext();
        }
        return pages;
      });
    },

    onGetSessions() {
      return sessionService.getSessions();
    },

    onSwitchSession(sessionKey     ) {
      return switchToSessionAndRunPostSwitchFlow(sessionKey);
    },

    async onCopySession(sourceKey     ) {
      const copied = await sessionService.copyForeignSession(sourceKey);
      let pages;
      try {
        pages = await switchToSessionAndRunPostSwitchFlow(copied.key);
      } catch (err) {
        if (!isSupersededSessionSwitchError(err)) throw err;

        broadcastSessions();
        return { sessionKey: copied.key, pages: null, superseded: true };
      }
      broadcastSessions();
      return { sessionKey: copied.key, pages };
    },

    onSessionDriverTakeOver(sessionKey     ) {
      return Promise.resolve({
        ok: false,
        error: "shared_handoff_unavailable",
        snapshot: sessionDriverWatch.snapshot(),
      });
    },

    async onAdoptSession(sourceKey     , options = {}) {
      const adopted = await sessionService.adoptForeignSession(sourceKey, options);
      let pages;
      try {
        pages = await switchToSessionAndRunPostSwitchFlow(adopted.key);
      } catch (err) {
        if (!isSupersededSessionSwitchError(err)) throw err;
        broadcastSessions();
        return { sessionKey: adopted.key, pages: null, superseded: true };
      }
      broadcastSessions();
      return { sessionKey: adopted.key, pages };
    },

    async onNewSession(request = {}) {
      const hasRequestedAgentRef = Reflect.has(request, "agentRef");
      const rawRequestedAgentRef = hasRequestedAgentRef
        ? Reflect.get(request, "agentRef")
        : "";
      const requestedAgentRef =
        typeof rawRequestedAgentRef === "string"
          ? rawRequestedAgentRef.trim()
          : "";
      let resolvedAgentRef = requestedAgentRef;
      if (requestedAgentRef) {
        const catalog = await getCapabilityAgentCatalogSnapshot();
        if (
          !catalog ||
          catalog.unsupported === true ||
          catalog.stale === true ||
          !Array.isArray(catalog.agents)
        ) {
          throw new Error("Agent catalog unavailable.");
        }
        const needle = requestedAgentRef.toLowerCase();
        const match = catalog.agents.find((entry = { id: "", name: "" }) => {
          if (!entry || typeof entry !== "object") return false;
          const id =
            typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
          const name =
            typeof entry.name === "string"
              ? entry.name.trim().toLowerCase()
              : "";
          return id === needle || name === needle;
        });
        if (!match) {
          throw new Error(`No agent named ${requestedAgentRef}.`);
        }
        resolvedAgentRef =
          typeof match.id === "string" && match.id.trim()
            ? match.id.trim()
            : requestedAgentRef;
      }
      if (Reflect.get(request, "scope") === "default") {
        const bindingResult = await setPathwayBinding("app", {
          backend: getActiveBackendKind(),
          agentRef: resolvedAgentRef,
        });
        if (!bindingResult || bindingResult.status !== "accepted") {
          throw new Error("Couldn't save the default session agent.");
        }
      }

      simulation.clearSyntheticWorkForSession(sessionService.ensureSessionKey());

      await hermesEnrollment.ensureFresh("new_session");

      if (hasRequestedAgentRef && hermesEnrollment.lacks(resolvedAgentRef)) {
        await hermesEnrollment.reread("new_session_pick");
      }

      let agentFallback = "";
      if (hasRequestedAgentRef && hermesEnrollment.agentRefIsUnenrolled(resolvedAgentRef)) {
        agentFallback = resolvedAgentRef;
        resolvedAgentRef = mintAgentRefs.getOcuClawDefaultAgentRefForMint();
      } else if (!hasRequestedAgentRef) {
        const rawBinding = mintAgentRefs.getAppPathwayAgentRef();
        if (hermesEnrollment.agentRefIsUnenrolled(rawBinding)) agentFallback = rawBinding;
      }
      if (agentFallback) {
        emitDebug(
          "relay.session",
          "hermes_agent_ref_not_enrolled",
          "warn",
          {},
          () => ({
            source: hasRequestedAgentRef ? "new_session_pick" : "app_pathway_binding",
            requested: agentFallback,
            fallback: mintAgentRefs.getOcuClawDefaultAgentRefForMint() || HERMES_DEFAULT_PROFILE,
          }),
        );
      }
      const hermesDraft = getActiveBackendKind() === "hermes";
      const result = await sessionService.newSession({
        ...(hasRequestedAgentRef ? { agentRef: resolvedAgentRef } : {}),
        sendResetCommand: !hermesDraft,
        materializeImmediately: !hermesDraft,
      });

      if (result && typeof result.sessionKey === "string" && result.sessionKey.trim()) {
        stablePromptSnapshots.evict(result.sessionKey);
        sessionService.clearDisplayToggleStates(result.sessionKey);
      }
      clearCurrentSessionModelConfigSnapshot("new_session");
      if (ctx.upstreamRuntime && typeof ctx.upstreamRuntime.clearTyping === "function") {
        ctx.upstreamRuntime.clearTyping("new_session");
      }
      if (ctx.upstreamRuntime && typeof ctx.upstreamRuntime.handleSessionChanged === "function") {
        ctx.upstreamRuntime.handleSessionChanged("new_session");
      }
      const sessionModelConfig = await seedOcuClawSessionConfigForNewSession(
        result && result.sessionKey,
      );
      return sessionModelConfig
        ? {
            ...result,
            draft: hermesDraft,
            ...(agentFallback ? { agentFallback } : {}),
            sessionModelConfig,
          }
        : {
            ...result,
            draft: hermesDraft,
            ...(agentFallback ? { agentFallback } : {}),
          };
    },

    onClientSessionSelected(clientId     , sessionKey     ) {
      noteAppClientSessionSelected(clientId, sessionKey);
      taskResultProposals.cancel(clientId);
      agentDrafts.cancel(clientId);
      taskFromWords.cancel(clientId);
      taskPresentations?.cancel(clientId);
      if (ctx.programCardFeed) ctx.server.unicast(clientId, programCardBindingsSnapshot(clientId));
    },

    onGetSessionModelConfig() {
      return sessionService.getCurrentSessionModelConfig();
    },

    async onSetSessionModelConfig(patch     ) {
      const result = await sessionService.setCurrentSessionModelConfig(patch || {});
      if (result && result.status === "accepted" && result.config) {
        adoptActiveSessionModelConfig(result.config);
      }
      return result;
    },

    onSetSessionAgent(patch     ) {
      if (getActiveBackendKind() === "hermes") {
        return {
          status: "rejected",
          error:
            "Hermes profiles own separate chats. Open or create the profile chat instead.",
        };
      }
      const sessionKey = sessionService.ensureSessionKey();
      const result = sessionService.setSessionAgentId(
        sessionKey,
        (patch && patch.agentId) || "",
      );
      if (!result || result.ok !== true) {
        return {
          status: "rejected",
          error: (result && result.reason) || "invalid session agent",
        };
      }

      if (typeof sessionService.primeSessionModelConfig === "function") {
        adoptActiveSessionModelConfig(sessionService.primeSessionModelConfig(sessionKey, {}));
      }
      broadcastSessions();

      ctx.upstreamRuntime?.invalidateSkillsCatalog?.("session_agent_changed");
      return { status: "accepted" };
    },

    async onGetEvenAiSessions() {
      return buildEvenAiSessionsSnapshot();
    },
  };
}

module.exports = { createRelaySessionHandlers };
