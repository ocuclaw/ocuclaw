const { APP_PROTOCOL } = require("./downstream-app-protocol.cjs");
const { formatError } = require("./downstream-codec-core.cjs");
const { formatSessions, formatSessionDiff, formatEmptySessionDiff, formatSessionSwitched, formatSessionSwitchRejected, formatSessionModelConfig, formatSessionModelConfigAck, formatCompactSessionAck, formatSessionAgentAck, formatSessionDriverState, normalizeSessionDiffLimit, normalizeSessionDiffKind } = require("./downstream-codec-sessions.cjs");
const { parseOptionalTrimmedString, parseOptionalBoolean } = require("./downstream-parse-optional.cjs");
const { isAdoptableHermesSessionKey, isForeignHermesSessionKey } = require("./hermes-session-keys.cjs");

function createSessionHandlers({
  logger,
  formatPages,
  defaultEvenAiDedicatedSessionKey,
  hasOwn,
  isRetiredEvenTerminalSessionKey,
  onClientSessionSelected,
  onNewChat,
  onGetSessions,
  onGetEvenAiSessions,
  onSwitchSession,
  onCopySession,
  onAdoptSession,
  onSessionDriverTakeOver,
  onNewSession,
  onGetSessionModelConfig,
  onSetSessionModelConfig,
  onSetSessionAgent,
  onCompactSession,
  onSetUserSessionTitle,
  onSetSessionPinned,
  onSetSessionHidden,
  onMarkAllSessionsRead,
  onDeleteSessions,
  onSearchTranscripts,
}     ) {

  function noteClientSessionSelected(clientId     , sessionKey     ) {
    if (!onClientSessionSelected || typeof sessionKey !== "string" || !sessionKey) return;
    try {
      onClientSessionSelected(clientId, sessionKey);
    } catch (err     ) {
      logger.warn(`[downstream] client session note failed: ${err && err.message ? err.message : err}`);
    }
  }

  function parseKnownSessionRows(msg) {
    if (!msg || !Array.isArray(msg.known)) return [];
    const out = [];
    for (const item of msg.known) {
      if (!item || typeof item !== "object") continue;
      const key = typeof item.key === "string" ? item.key.trim() : "";
      if (!key) continue;
      out.push({
        key,
        updatedAt: Number.isFinite(Number(item.updatedAt))
          ? Math.floor(Number(item.updatedAt))
          : 0,
        fingerprint:
          typeof item.fingerprint === "string" ? item.fingerprint.trim() : "",
      });
    }
    return out;
  }

  function parseSetSessionModelConfig(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("setSessionModelConfig payload must be an object");
    }

    const payload = {};
    let parsedModelRef = "";

    if (Object.prototype.hasOwnProperty.call(msg, "modelRef")) {
      if (typeof msg.modelRef !== "string") {
        throw new Error("modelRef must be in provider/id format or blank");
      }
      const modelRef = msg.modelRef.trim();
      if (!modelRef) {
        payload.modelRef = "";
      } else {
        if (!modelRef.includes("/")) {
          throw new Error("modelRef must be in provider/id format");
        }
        payload.modelRef = modelRef;
        parsedModelRef = modelRef;
      }
    }

    if (Object.prototype.hasOwnProperty.call(msg, "thinkingLevel")) {
      if (typeof msg.thinkingLevel !== "string") {
        throw new Error(
          "thinkingLevel must be blank|off|minimal|low|medium|high|xhigh|adaptive|max|ultra",
        );
      }
      const normalized = msg.thinkingLevel.trim().toLowerCase();

      if (
        normalized &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"].includes(normalized)
      ) {
        throw new Error(
          "thinkingLevel must be blank|off|minimal|low|medium|high|xhigh|adaptive|max|ultra",
        );
      }
      payload.thinkingLevel = normalized;
    }

    const oneTurn = parseOptionalBoolean(msg.oneTurn, "oneTurn");
    if (oneTurn !== undefined) {
      if (oneTurn && !parsedModelRef) {
        throw new Error("oneTurn requires a non-blank modelRef");
      }
      Object.assign(payload, { oneTurn });
    }

    if (Object.prototype.hasOwnProperty.call(msg, "reasoningLevel")) {
      if (typeof msg.reasoningLevel !== "string") {
        throw new Error("reasoningLevel must be off|on|on.full");
      }
      const normalized = msg.reasoningLevel.trim().toLowerCase();
      if (!["off", "on", "on.full"].includes(normalized)) {
        throw new Error("reasoningLevel must be off|on|on.full");
      }
      Object.assign(payload, { reasoningLevel: normalized });
    }

    const reasoningEnabled = parseOptionalBoolean(
      msg.reasoningEnabled,
      "reasoningEnabled",
    );
    if (reasoningEnabled !== undefined) {
      payload.reasoningEnabled = reasoningEnabled;
    }

    const verboseLevel = parseOptionalTrimmedString(msg.verboseLevel);
    if (verboseLevel) {
      const normalized = verboseLevel.toLowerCase();
      if (!["off", "on", "full"].includes(normalized)) {
        throw new Error("verboseLevel must be off|on|full");
      }
      payload.verboseLevel = normalized;
    }

    const fastMode = parseOptionalBoolean(msg.fastMode, "fastMode");
    if (fastMode !== undefined) {
      payload.fastMode = fastMode;
    }

    const elevatedLevel = parseOptionalTrimmedString(msg.elevatedLevel);
    if (elevatedLevel) {
      const normalized = elevatedLevel.toLowerCase();
      if (!["off", "on", "ask", "full"].includes(normalized)) {
        throw new Error("elevatedLevel must be off|on|ask|full");
      }
      payload.elevatedLevel = normalized;
    }

    if (Object.keys(payload).length === 0) {
      throw new Error("setSessionModelConfig requires at least one field");
    }

    return payload;
  }

  function parseNewSession(msg = { agentRef: "", scope: "", requestId: "" }) {
    const payload = {
      scope: "once",
      requestId: parseOptionalTrimmedString(msg && msg.requestId),
    };
    if (hasOwn(msg, "agentRef")) {
      if (typeof msg.agentRef !== "string") {
        throw new Error("agentRef must be a string");
      }
      Object.assign(payload, { agentRef: msg.agentRef.trim() });
    }
    if (hasOwn(msg, "scope")) {
      if (typeof msg.scope !== "string") {
        throw new Error("scope must be once|default");
      }
      const scope = msg.scope.trim().toLowerCase();
      if (scope !== "once" && scope !== "default") {
        throw new Error("scope must be once|default");
      }
      payload.scope = scope;
    }
    return payload;
  }

  function handleNewChat(clientId) {
    return onNewChat().then(
      (result) => {
        if (result && typeof result === "object" && typeof result.sessionKey === "string") {

          noteClientSessionSelected(clientId, result.sessionKey);
          return {
            broadcast: [
              formatSessionSwitched(result.sessionKey, "", result.draft === true),
              formatPages(Array.isArray(result.pages) ? result.pages : []),
            ],
          };
        }
        return { broadcast: formatPages(result) };
      },
      (err) => {
        logger.error(`[downstream] newChat failed: ${err.message}`);
        return null;
      },
    );
  }

  function handleGetSessions(clientId) {
    return onGetSessions().then(
      (sessions) => ({ unicast: formatSessions(sessions) }),
      (err) => {
        logger.error(`[downstream] getSessions failed: ${err.message}`);
        return { unicast: formatSessions([]) };
      },
    );
  }

  function handleGetSessionDiff(clientId, msg) {
    const kind = normalizeSessionDiffKind(msg && msg.kind);
    if (!kind) {
      return Promise.resolve({
        unicast: formatError("invalid_session_diff_kind", {}),
      });
    }
    const known = parseKnownSessionRows(msg);
    const limit = normalizeSessionDiffLimit(msg && msg.limit);
    if (kind === "evenai") {
      if (!onGetEvenAiSessions) {
        return Promise.resolve({
          unicast: formatEmptySessionDiff(
            kind,
            limit,
            defaultEvenAiDedicatedSessionKey,
          ),
        });
      }
      return Promise.resolve(onGetEvenAiSessions()).then(
        (payload) => ({
          unicast: formatSessionDiff({
            kind,
            sessions: payload && payload.sessions,
            known,
            limit,
            dedicatedKey:
              payload && typeof payload.dedicatedKey === "string"
                ? payload.dedicatedKey
                : defaultEvenAiDedicatedSessionKey,
          }),
        }),
        (err) => {
          logger.error(`[downstream] getEvenAiSessionDiff failed: ${err.message}`);
          return {
            unicast: formatEmptySessionDiff(
              kind,
              limit,
              defaultEvenAiDedicatedSessionKey,
            ),
          };
        },
      );
    }
    return onGetSessions().then(
      (sessions) => ({
        unicast: formatSessionDiff({ kind, sessions, known, limit }),
      }),
      (err) => {
        logger.error(`[downstream] getSessionDiff failed: ${err.message}`);
        return { unicast: formatEmptySessionDiff(kind, limit) };
      },
    );
  }

  function handleGetSessionModelConfig(clientId) {
    if (!onGetSessionModelConfig) {
      return { unicast: formatError("getSessionModelConfig is not available") };
    }
    return Promise.resolve(onGetSessionModelConfig()).then(
      (payload) => ({
        unicast: formatSessionModelConfig(payload || {}),
      }),
      (err) => {
        logger.error(`[downstream] getSessionModelConfig failed: ${err.message}`);
        return { unicast: formatError(err.message || "getSessionModelConfig failed") };
      },
    );
  }

  function parseSetSessionAgent(msg) {
    if (!msg || typeof msg !== "object") {
      throw new Error("setSessionAgent payload must be an object");
    }
    if (!Object.prototype.hasOwnProperty.call(msg, "agentId")) {
      throw new Error("setSessionAgent requires an agentId field");
    }
    if (msg.agentId !== null && typeof msg.agentId !== "string") {
      throw new Error("agentId must be a string or null");
    }
    return { agentId: typeof msg.agentId === "string" ? msg.agentId.trim() : "" };
  }

  function handleSetSessionAgent(clientId, msg) {
    if (!onSetSessionAgent) {
      return {
        unicast: formatSessionAgentAck({
          status: "rejected",
          error: "setSessionAgent is not available",
        }),
      };
    }
    let payload;
    try {
      payload = parseSetSessionAgent(msg);
    } catch (err) {
      return {
        unicast: formatSessionAgentAck({
          status: "rejected",
          error: err && err.message ? err.message : "invalid setSessionAgent payload",
        }),
      };
    }
    return Promise.resolve(onSetSessionAgent(payload)).then(
      (result) => ({
        unicast: formatSessionAgentAck(result || { status: "accepted" }),
      }),
      (err) => ({
        unicast: formatSessionAgentAck({
          status: "rejected",
          error: err && err.message ? err.message : "setSessionAgent failed",
        }),
      }),
    );
  }

  function handleSetSessionModelConfig(clientId, msg) {
    const requestId =
      msg && typeof msg.requestId === "string" && msg.requestId.trim()
        ? msg.requestId.trim()
        : undefined;
    const formatAck = (payload) =>
      formatSessionModelConfigAck(
        requestId === undefined ? payload : { ...payload, requestId },
      );

    if (!onSetSessionModelConfig) {
      return {
        unicast: formatAck({
          status: "rejected",
          error: "setSessionModelConfig is not available",
        }),
      };
    }

    let payload;
    try {
      payload = parseSetSessionModelConfig(msg);
    } catch (err) {
      return {
        unicast: formatAck({
          status: "rejected",
          error: err && err.message ? err.message : "invalid setSessionModelConfig payload",
        }),
      };
    }

    return Promise.resolve(onSetSessionModelConfig(payload)).then(
      (result) =>
        ({
          unicast: formatAck(result || { status: "accepted" }),
        }),
      (err) =>
        ({
          unicast: formatAck({
            status: "rejected",
            error: err && err.message ? err.message : "setSessionModelConfig failed",
          }),
        }),
    );
  }

  function handleCompactSession(clientId, msg) {
    if (!onCompactSession) {
      return Promise.resolve({
        unicast: formatCompactSessionAck({
          status: "rejected",
          requestId: msg && msg.requestId,
          error: "compactSession is not available",
        }),
      });
    }
    const sessionKey =
      msg && typeof msg.sessionKey === "string" && msg.sessionKey
        ? msg.sessionKey
        : null;
    if (!sessionKey) {
      return Promise.resolve({
        unicast: formatCompactSessionAck({
          status: "rejected",
          requestId: msg && msg.requestId,
          error: "sessionKey is required",
        }),
      });
    }
    return Promise.resolve(onCompactSession({ sessionKey })).then(
      (result) => ({
        unicast: formatCompactSessionAck({
          ...(result || { status: "accepted" }),
          requestId: msg.requestId,
        }),
      }),
      (err) => ({
        unicast: formatCompactSessionAck({
          status: "rejected",
          requestId: msg.requestId,
          error: err && err.message ? err.message : "compactSession failed",
        }),
      }),
    );
  }

  function handleSwitchSession(clientId, msg) {
    if (!msg.sessionKey) return null;
    if (isRetiredEvenTerminalSessionKey(msg.sessionKey)) {
      return {
        broadcast: [
          formatSessionSwitchRejected({
            sessionKey: msg.sessionKey,
            reason: "unsupported_session_key",
          }),
        ],
      };
    }
    return onSwitchSession(msg.sessionKey).then(
      (pages) => {
        noteClientSessionSelected(clientId, msg.sessionKey);
        return {
          broadcast: [
            formatSessionSwitched(msg.sessionKey),
            formatPages(pages),
          ],
        };
      },
      (err) => {

        if (
          err &&
          (err.reason === "session_switch_superseded" ||
            err.code === "session_switch_superseded")
        ) {
          return null;
        }
        logger.error(`[downstream] switchSession failed: ${err.message}`);
        if (err && (err.reason === "unsupported_session_key" || err.code === "unsupported_session_key")) {
          return {
            broadcast: [
              formatSessionSwitchRejected({
                sessionKey: msg.sessionKey,
                reason: "unsupported_session_key",
                currentSessionKey: err.currentSessionKey,
              }),
            ],
          };
        }
        return null;
      },
    );
  }

  function handleCopySession(clientId, msg) {
    if (!msg.sessionKey) return null;
    if (!isForeignHermesSessionKey(msg.sessionKey)) {
      return {
        unicast: JSON.stringify({
          type: APP_PROTOCOL.sessionCopyAck,
          ok: false,
          copiedFrom: msg.sessionKey,
          error: "foreign_session_copy_requires_foreign_source",
        }),
      };
    }
    return onCopySession(msg.sessionKey).then(
      (result) => {
        const ack = {
          unicast: JSON.stringify({
            type: APP_PROTOCOL.sessionCopyAck,
            ok: true,
            key: result.sessionKey,
            copiedFrom: msg.sessionKey,
          }),
        };

        if (result.superseded === true) return ack;
        noteClientSessionSelected(clientId, result.sessionKey);
        return {
          ...ack,
          broadcast: [
            formatSessionSwitched(result.sessionKey),
            formatPages(result.pages),
          ],
        };
      },
      (err) => {
        logger.error(`[downstream] copySession failed: ${err.message}`);
        return {
          unicast: JSON.stringify({
            type: APP_PROTOCOL.sessionCopyAck,
            ok: false,
            copiedFrom: msg.sessionKey,
            error: err.message,
          }),
        };
      },
    );
  }

  function handleSessionDriverTakeOver(clientId     , msg     ) {
    const sessionKey = parseOptionalTrimmedString(msg && msg.sessionKey);
    if (!sessionKey) return null;
    const refused = (error     , snapshot     ) => ({
      unicast: JSON.stringify({
        ...JSON.parse(formatSessionDriverState(snapshot || { sessionKey })),
        error,
      }),
    });
    if (typeof onSessionDriverTakeOver !== "function") {
      return refused("session_driver_unsupported", null);
    }
    return Promise.resolve(onSessionDriverTakeOver(sessionKey)).then(
      (result     ) => {
        if (!result || result.ok !== true) {
          return refused((result && result.error) || "take_over_refused", result && result.snapshot);
        }
        return { broadcast: [formatSessionDriverState(result.snapshot)] };
      },
      (err     ) => {
        logger.error(`[downstream] sessionDriverTakeOver failed: ${err.message}`);
        return refused(err.message, null);
      },
    );
  }

  function handleAdoptSession(clientId     , msg     ) {
    if (!msg.sessionKey) return null;

    const rejected = (error     , holdState      = null) => ({
      unicast: JSON.stringify({
        type: APP_PROTOCOL.sessionAdoptAck,
        ok: false,
        adoptedFrom: msg.sessionKey,
        error,
        ...(typeof holdState === "string" && holdState.trim() ? { holdState: holdState.trim() } : {}),
      }),
    });
    if (!isAdoptableHermesSessionKey(msg.sessionKey)) {
      return rejected("foreign_session_adopt_requires_external_source");
    }
    if (typeof onAdoptSession !== "function") {
      return rejected("foreign_session_adopt_unsupported");
    }
    const options = msg.takeOver === true ? { takeOver: true } : {};
    return onAdoptSession(msg.sessionKey, options).then(
      (result     ) => {
        const ack = {
          unicast: JSON.stringify({
            type: APP_PROTOCOL.sessionAdoptAck,
            ok: true,
            key: result.sessionKey,
            adoptedFrom: msg.sessionKey,
          }),
        };
        if (result.superseded === true) return ack;
        noteClientSessionSelected(clientId, result.sessionKey);
        return {
          ...ack,
          broadcast: [
            formatSessionSwitched(result.sessionKey),
            formatPages(result.pages, undefined),
          ],
        };
      },
      (err     ) => {
        logger.error(`[downstream] adoptSession failed: ${err.message}`);
        return rejected(err.message, err && err.holdState);
      },
    );
  }

  function handleNewSession(
    clientId,
    msg = { agentRef: "", scope: "", requestId: "" },
  ) {
    let payload;
    try {
      payload = parseNewSession(msg);
    } catch (err) {
      return {
        unicast: formatError(
          err instanceof Error ? err.message : "invalid newSession payload",
          {
            requestId: parseOptionalTrimmedString(msg && msg.requestId),
            op: APP_PROTOCOL.sessionCreate,
          },
        ),
      };
    }
    return Promise.resolve(onNewSession(payload)).then(
      (result) => {
        noteClientSessionSelected(clientId, result && result.sessionKey);
        const broadcast = [
          formatSessionSwitched(
            result.sessionKey,
            payload.requestId,
            result.draft,
            result && result.agentFallback,
          ),
          formatPages(result.pages),
        ];
        if (result && result.sessionModelConfig) {
          broadcast.push(formatSessionModelConfig(result.sessionModelConfig));
        }
        return { broadcast };
      },
      (err) => {
        logger.error(`[downstream] newSession failed: ${err.message}`);
        return {
          unicast: formatError(
            err instanceof Error ? err.message : "newSession failed",
            {
              requestId: payload.requestId,
              op: APP_PROTOCOL.sessionCreate,
            },
          ),
        };
      },
    );
  }

  function handleSetUserSessionTitle(clientId, msg) {
    if (typeof onSetUserSessionTitle !== "function") return null;
    const sessionKey =
      typeof msg.sessionKey === "string" ? msg.sessionKey.trim() : "";
    const title = typeof msg.title === "string" ? msg.title.trim() : "";
    if (!sessionKey || !title) return null;
    if (title.length > 55) return null;

    const errorAction = (code) => ({
      unicast: formatError(code, {
        code,
        op: "session.title.set",
      }),
    });
    if (isForeignHermesSessionKey(sessionKey)) {
      return errorAction("session_not_renamable");
    }

    const failure = (err) => {
      const message = err && err.message ? err.message : String(err || "");
      const conflict = /already in use|unique/i.test(message);
      const code = conflict
        ? "session_title_conflict"
        : "session_title_update_failed";
      return errorAction(code);
    };

    const finish = (resolved) => {
      if (!resolved || resolved.ok !== false) return null;
      return resolved.code === "session_title_conflict"
        ? errorAction("session_title_conflict")
        : failure(new Error(resolved.code || "title update rejected"));
    };
    try {
      const result = onSetUserSessionTitle(sessionKey, title);
      if (result && typeof result.then === "function") {
        return result.then(finish, failure);
      }
      return finish(result);
    } catch (err) {
      return failure(err);
    }
  }

  function handleSetSessionPinned(clientId, msg) {
    if (typeof onSetSessionPinned !== "function") return null;
    const sessionKey =
      typeof msg.sessionKey === "string" ? msg.sessionKey.trim() : "";
    const pinned = msg.pinned === true;
    const kind = msg.kind;
    if (
      !sessionKey ||
      isForeignHermesSessionKey(sessionKey) ||
      (kind !== "ocuclaw" && kind !== "evenai")
    ) {
      return { unicast: formatError("invalid_session_pin_request") };
    }
    const result = onSetSessionPinned(sessionKey, pinned, kind);
    if (result && result.ok === false) {
      const code = result.reason === "cap" ? "pin_cap_reached" : "invalid_session_pin_request";
      return { unicast: formatError(code) };
    }
    return null;
  }

  function handleSetSessionHidden(clientId     , msg     ) {
    if (typeof onSetSessionHidden !== "function") return null;
    const sessionKey =
      typeof msg.sessionKey === "string" ? msg.sessionKey.trim() : "";
    if (!sessionKey) {
      return {
        unicast: formatError("invalid_session_hidden_request", {
          code: "invalid_session_hidden_request",
          op: "session.hidden.set",
        }),
      };
    }
    const hidden = msg.hidden === true;
    const finish = (result     ) => {
      if (result && result.ok === false) {
        const code =
          typeof result.code === "string"
            ? result.code
            : "invalid_session_hidden_request";
        return {
          unicast: formatError(code, { code, op: "session.hidden.set" }),
        };
      }
      return null;
    };
    const failure = (err     ) => {
      logger.warn(
        `[handler] session.hidden.set failed: ${err && err.message ? err.message : err}`,
      );
      return {
        unicast: formatError("session_hidden_update_failed", {
          code: "session_hidden_update_failed",
          op: "session.hidden.set",
        }),
      };
    };
    try {
      const result = onSetSessionHidden(sessionKey, hidden);
      if (result && typeof result.then === "function") {
        return result.then(finish, failure);
      }
      return finish(result);
    } catch (err) {
      return failure(err);
    }
  }

  function handleMarkAllSessionsRead(clientId     , msg     ) {
    if (typeof onMarkAllSessionsRead !== "function") return null;
    const op = "session.read.all";
    const finish = (result     ) => {
      if (result && result.ok === false) {
        const code =
          typeof result.code === "string" ? result.code : "session_read_all_failed";
        return { unicast: formatError(code, { code, op }) };
      }
      return null;
    };
    const failure = (err     ) => {
      logger.warn(
        `[handler] session.read.all failed: ${err && err.message ? err.message : err}`,
      );
      return {
        unicast: formatError("session_read_all_failed", {
          code: "session_read_all_failed",
          op,
        }),
      };
    };
    try {
      const result = onMarkAllSessionsRead();
      if (result && typeof result.then === "function") {
        return result.then(finish, failure);
      }
      return finish(result);
    } catch (err) {
      return failure(err);
    }
  }

  function handleDeleteSessions(clientId, msg) {
    if (typeof onDeleteSessions !== "function") return null;
    const sessionKeys = Array.isArray(msg.sessionKeys) ? msg.sessionKeys.filter((k) => typeof k === "string" && k) : [];
    const kind = msg.kind;
    const switchBeforeDelete = msg.switchBeforeDelete === true;
    if (
      sessionKeys.length === 0 ||
      sessionKeys.some(isForeignHermesSessionKey) ||
      (kind !== "ocuclaw" && kind !== "evenai")
    ) {
      return { unicast: formatError("invalid_session_delete_request") };
    }
    onDeleteSessions(sessionKeys, kind, switchBeforeDelete);
    return null;
  }

  function handleSearchTranscripts(clientId, msg) {
    if (typeof onSearchTranscripts !== "function") return null;
    const query = typeof msg.query === "string" ? msg.query : "";
    const kind = msg.kind;
    const requestId = typeof msg.requestId === "string" && msg.requestId.trim()
      ? msg.requestId.trim() : undefined;
    if (!query.trim() || (kind !== "ocuclaw" && kind !== "evenai")) {
      return { unicast: formatError("invalid_transcript_search_request", { requestId }) };
    }
    onSearchTranscripts(clientId, query, kind, requestId);
    return null;
  }

  return {
    handleNewChat,
    handleGetSessions,
    handleGetSessionDiff,
    handleGetSessionModelConfig,
    handleSetSessionAgent,
    handleSetSessionModelConfig,
    handleCompactSession,
    handleSwitchSession,
    handleCopySession,
    handleSessionDriverTakeOver,
    handleAdoptSession,
    handleNewSession,
    handleSetUserSessionTitle,
    handleSetSessionPinned,
    handleSetSessionHidden,
    handleMarkAllSessionsRead,
    handleDeleteSessions,
    handleSearchTranscripts,
  };
}

module.exports = { createSessionHandlers };
