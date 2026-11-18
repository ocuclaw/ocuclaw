const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isForcedClientEvent } = require("../domain/critical-client-events.cjs");
const { UPLOAD_CAPTURE_PRESET } = require("../domain/debug-upload-preset.cjs");
const { parseEventDebug } = require("./downstream-handler.cjs");
const { handleDebugBundleRequest, handleDebugBundleSave, handleDebugBundleFetch } = require("./debug-bundle-handler.cjs");
const { saveBundleToDisk } = require("../domain/debug-bundle-save.cjs");
const { CARD_STUDIO_CATEGORY, CARD_STUDIO_PRESS_EVENT, cardStudioPressData } = require("../domain/card-studio-stream.cjs");

function createRelayToolingHandlers(ctx                             ) {
  const {
    emitDebug,
    sessionService,
    opts,
    logger,
    debugStore,
    relayBackendKind,
    bundleCache,
    clientEventFoldCache,
    externalDebugToolsEnabled,
    hermesVersion,
    debugUploadMaxZipBytes,
    cardStudioReport,
    resolveSaveDir,
    isDebugBundlePhoneHandoffAllowed,
    writeConsoleLog,
    cardStudio,
    isForcedLiveuiFailureEvent,
    dispatchGlassesUiClientFailure,
    applyDebugSet,
    applyTraceLogSet,
    liveUiTraceFlagPath,
    armRemoteSendRunBinding,
  } = ctx;

  return {

    onDebugBundleRequest(clientId     , msg     ) {

      const reportedClientVersion = (() => {
        try {
          const snap =
            ctx.server && typeof ctx.server.getReadinessSnapshot === "function"
              ? ctx.server.getReadinessSnapshot()
              : null;
          const entry =
            snap && Array.isArray(snap.clients)
              ? snap.clients.find((c     ) => c.clientId === clientId)
              : null;
          const v = entry && typeof entry.clientVersion === "string" ? entry.clientVersion.trim() : "";
          return v.length ? v : null;
        } catch {
          return null;
        }
      })();
      const clientEvents = clientEventFoldCache.get({
        foldId: msg.foldId,
        installId: msg.installId,
        ringRevision: msg.ringRevision,
      });
      const deps = {
        gatesOn: () => externalDebugToolsEnabled,
        dump: (query     ) => debugStore.dump(query),

        preset:
          opts.debugUploadCapturePreset &&
          Array.isArray(opts.debugUploadCapturePreset) &&
          opts.debugUploadCapturePreset.length
            ? opts.debugUploadCapturePreset
            : UPLOAD_CAPTURE_PRESET,

        build: {
          clientVersion: reportedClientVersion,
          requiresClientVersion: ctx.pluginVersionService.getRequiresClientVersion(),
          pluginVersion: ctx.pluginVersionService.getPluginVersion(),
          openclawVersion:
            relayBackendKind === "openclaw"
              ? ctx.pluginVersionService.getOpenClawHostVersion()
              : null,
          distHash: ctx.pluginVersionService.getDistHash(),
          ...(relayBackendKind === "hermes"
            ? { backendKind: "hermes", hermesVersion }
            : {}),
        },
        maxZipBytes: debugUploadMaxZipBytes,
        chunkBytes: 64000,
        send: (id     , frame     ) => {
          if (ctx.server) ctx.server.unicast(id, JSON.stringify(frame));
        },

        emit: (event     , data     ) =>
          emitDebug("relay.operation", event, "debug", {}, () => data),
        logError: (m     ) => logger.error(`[relay] ${m}`),
        newBundleId: () => crypto.randomUUID(),
        cachePut: (id = "", e = {}) => bundleCache.put(id, e),
        now: () => Date.now(),
        clientEvents,
        currentSessionKey: () => sessionService.ensureSessionKey(),
        parseClientEvent: parseEventDebug,

        cardStudioReport: (query     ) => cardStudioReport.build(query),
      };
      if (
        relayBackendKind === "hermes" &&
        typeof opts.getConnectionHealthDocument === "function"
      ) {

        Object.defineProperty(deps, "getConnectionHealthDocument", {
          value: opts.getConnectionHealthDocument,
          enumerable: true,
        });
      }
      return Promise.resolve(handleDebugBundleRequest(deps, clientId, msg)).catch(
        (err) => {
          logger.error(
            `[relay] debug-bundle-request failed: ${err && err.message ? err.message : err}`,
          );
        },
      );
    },

    onDebugBundleClientEvents(_clientId     , msg     ) {
      return clientEventFoldCache.accept(msg);
    },

    onDebugBundleSave(clientId     , msg     ) {
      return Promise.resolve(handleDebugBundleSave({
        gatesOn: () => externalDebugToolsEnabled,
        cacheGet: (id     ) => bundleCache.get(id),
        saveBundle: (a     ) => saveBundleToDisk({ ...a, saveDir: resolveSaveDir(), fs, path }),
        now: () => Date.now(),
        send: (id     , frame     ) => { if (ctx.server) ctx.server.unicast(id, JSON.stringify(frame)); },
        emit: (event     , data     ) => emitDebug("relay.operation", event, "debug", {}, () => data),
        logError: (m     ) => logger.error(`[relay] ${m}`),
      }, clientId, msg)).catch((err) => {
        logger.error(`[relay] debug-bundle-save failed: ${err && err.message ? err.message : err}`);
      });
    },

    onDebugBundleFetch(clientId     , msg     ) {
      return Promise.resolve(handleDebugBundleFetch({
        gatesOn: isDebugBundlePhoneHandoffAllowed,
        cacheGet: (id     ) => bundleCache.get(id),
        chunkBytes: 64000,
        send: (id     , frame     ) => { if (ctx.server) ctx.server.unicast(id, JSON.stringify(frame)); },
        emit: (event     , data     ) => emitDebug("relay.operation", event, "debug", {}, () => data),
      }, clientId, msg)).catch((err) => {
        logger.error(`[relay] debug-bundle-fetch failed: ${err && err.message ? err.message : err}`);
      });
    },

    onConsoleLog(level     , message     ) {
      writeConsoleLog(level, message);
      if (level === "event") {
        emitDebug(
          "sdk.events",
          "event_debug",
          "debug",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            level,
            message,
          }),
        );
      }
    },

    onEventDebug(clientId     , payload     ) {
      if (!payload || typeof payload !== "object") return;
      let cat = payload.cat;

      if (cat === CARD_STUDIO_CATEGORY || payload.event === CARD_STUDIO_PRESS_EVENT) {
        const press = payload.event === CARD_STUDIO_PRESS_EVENT ? cardStudioPressData(payload.data) : null;
        if (!press) return;
        payload = { ...payload, cat: CARD_STUDIO_CATEGORY, data: press };
        cat = CARD_STUDIO_CATEGORY;

        try { cardStudio.notePress(press); } catch {  }
      }
      const forceStore = isForcedClientEvent(payload);
      if (!forceStore && !debugStore.isEnabled(cat)) return;
      emitDebug(
        cat,
        payload.event,
        payload.severity || "debug",
        {
          sessionKey: payload.sessionKey || sessionService.ensureSessionKey(),
          runId: payload.runId || null,
          screen: payload.screen || null,
        },
        () => ({
          clientId,
          ...(payload.data || {}),
        }),
        { force: forceStore },
      );

      if (isForcedLiveuiFailureEvent(payload)) {
        dispatchGlassesUiClientFailure(clientId, payload.data || {});
      }
    },

    onDebugSet(clientId     , request     ) {
      return applyDebugSet(clientId, request);
    },

    onTraceLogSet(clientId     , request     ) {
      return applyTraceLogSet(clientId, request);
    },

    onTraceLogGet() {
      return { ok: true, enabled: ctx.liveUiTraceLogEnabled, persistedPath: liveUiTraceFlagPath };
    },

    onDebugDump(clientId     , request     ) {
      const result = debugStore.dump(request);
      if (!result.ok) {
        throw new Error(result.error || "debug-dump failed");
      }

      emitDebug(
        "relay.protocol",
        "debug_dump",
        "debug",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          categories: result.categories,
          redaction: result.redaction,
          limit: result.limit,
          returned: result.returned,
          totalMatched: result.totalMatched,
        }),
      );

      return result;
    },

    onRemoteControl(clientId     , request     ) {
      const now = Date.now();
      const requestId =
        (typeof request.requestId === "string" && request.requestId.trim()) ||
        `rc-${now}-${Math.random().toString(16).slice(2, 8)}`;
      const isDebugCloseAppClientAction =
        request &&
        request.action === "relay-action" &&
        request.relayAction === "debug-close-app-client";
      const recipientEstimate = ctx.server ? ctx.server.getConnectedAppCount(clientId) : 0;

      emitDebug(
        "relay.protocol",
        "remote_control_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          action: request.action || "unknown",
          recipientEstimate,
        }),
      );

      if (recipientEstimate <= 0) {
        return {
          ok: false,
          requestId,
          message: "No downstream app clients connected",
          detail: { recipientEstimate },
        };
      }

      if (isDebugCloseAppClientAction) {
        if (!ctx.server || typeof ctx.server.closeConnectedAppClients !== "function") {
          return {
            ok: false,
            requestId,
            message: "Downstream close hook unavailable",
            detail: { recipientEstimate },
          };
        }
        const closeResult = ctx.server.closeConnectedAppClients({
          excludeClientId: clientId,
          reason: "debug_close_app_client",
        });
        emitDebug(
          "relay.protocol",
          "remote_control_server_action_applied",
          "warn",
          { sessionKey: sessionService.ensureSessionKey() },
          () => ({
            clientId,
            requestId,
            action: request.action || "unknown",
            relayAction: request.relayAction || null,
            recipientEstimate,
            closedCount: closeResult.closedCount,
            closedClientIds: closeResult.closedClientIds,
            reason: closeResult.reason,
          }),
        );
        return {
          ok: closeResult.closedCount > 0,
          requestId,
          message:
            closeResult.closedCount > 0
              ? `Closed ${closeResult.closedCount} app client(s)`
              : "No downstream app clients connected",
          detail: {
            recipientEstimate,
            closedCount: closeResult.closedCount,
            closedClientIds: closeResult.closedClientIds,
            reason: closeResult.reason,
          },
        };
      }

      const control = {
        ...request,
        requestId,
        issuedAtMs: now,
        issuedByClientId: clientId,
      };

      if (control.action === "send-message") {
        armRemoteSendRunBinding({
          requestId,
          clientId,
          sessionKey: control.sessionKey || null,
        });
      }

      emitDebug(
        "relay.protocol",
        "remote_control_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          action: control.action || "unknown",
          recipientEstimate,
          runBindingArmed: control.action === "send-message",
        }),
      );

      return {
        ok: true,
        requestId,
        message: `Dispatched to ${recipientEstimate} client(s)`,
        detail: { recipientEstimate },
        control,
      };
    },

    onReadinessProbe(clientId     , request     ) {
      const now = Date.now();
      const requestId =
        (typeof request.requestId === "string" && request.requestId.trim()) ||
        `readiness-${now}-${Math.random().toString(16).slice(2, 8)}`;
      const sinceMs = Number.isFinite(Number(request && request.sinceMs))
        ? Math.max(0, Math.floor(Number(request.sinceMs)))
        : now;
      const snapshot =
        ctx.server && typeof ctx.server.getReadinessSnapshot === "function"
          ? ctx.server.getReadinessSnapshot()
          : {
              connectedClientCount: 0,
              fanoutRecipientCount: 0,
              clients: [],
            };
      const targetClientId =
        snapshot &&
        snapshot.connectedClientCount === 1 &&
        snapshot.fanoutRecipientCount === 1 &&
        Array.isArray(snapshot.clients) &&
        snapshot.clients.length === 1 &&
        typeof snapshot.clients[0].clientId === "string"
          ? snapshot.clients[0].clientId
          : null;

      emitDebug(
        "relay.protocol",
        "readiness_probe_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          sinceMs,
          requestedSessionKey:
            typeof request.sessionKey === "string" && request.sessionKey.trim()
              ? request.sessionKey.trim()
              : null,
          connectedClientCount:
            snapshot && Number.isFinite(snapshot.connectedClientCount)
              ? snapshot.connectedClientCount
              : 0,
          fanoutRecipientCount:
            snapshot && Number.isFinite(snapshot.fanoutRecipientCount)
              ? snapshot.fanoutRecipientCount
              : 0,
        }),
      );

      if (
        !snapshot ||
        snapshot.connectedClientCount <= 0 ||
        snapshot.fanoutRecipientCount <= 0
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "no_downstream_client",
          message: "No downstream app clients connected",
        };
      }

      if (
        snapshot.connectedClientCount > 1 ||
        snapshot.fanoutRecipientCount > 1 ||
        !targetClientId
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "multi_recipient_fanout",
          message: "Multiple downstream app clients connected",
        };
      }

      emitDebug(
        "relay.protocol",
        "readiness_probe_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          targetClientId,
          sinceMs,
        }),
      );

      return {
        ok: true,
        requestId,
        targetClientId,
        probe: {
          requestId,
          sinceMs,
          sessionKey:
            typeof request.sessionKey === "string" && request.sessionKey.trim()
              ? request.sessionKey.trim()
              : null,
        },
      };
    },

    onAutomationRegistry(clientId     ) {
      const snapshot =
        ctx.server && typeof ctx.server.getReadinessSnapshot === "function"
          ? ctx.server.getReadinessSnapshot()
          : {
              connectedClientCount: 0,
              fanoutRecipientCount: 0,
              clients: [],
            };
      const targetEntry =
        snapshot &&
        snapshot.connectedClientCount === 1 &&
        snapshot.fanoutRecipientCount === 1 &&
        Array.isArray(snapshot.clients) &&
        snapshot.clients.length === 1
          ? snapshot.clients[0]
          : null;
      const targetClientId =
        targetEntry && typeof targetEntry.clientId === "string"
          ? targetEntry.clientId
          : null;
      const readinessPublished =
        !!(
          targetEntry &&
          targetEntry.readinessSnapshot &&
          Number.isFinite(targetEntry.readinessSnapshot.emittedAtMs)
        );

      emitDebug(
        "relay.protocol",
        "automation_registry_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          connectedClientCount:
            snapshot && Number.isFinite(snapshot.connectedClientCount)
              ? snapshot.connectedClientCount
              : 0,
          fanoutRecipientCount:
            snapshot && Number.isFinite(snapshot.fanoutRecipientCount)
              ? snapshot.fanoutRecipientCount
              : 0,
        }),
      );

      if (
        !snapshot ||
        snapshot.connectedClientCount <= 0 ||
        snapshot.fanoutRecipientCount <= 0
      ) {
        return {
          ok: false,
          reasonCode: "no_downstream_client",
          message: "No downstream app clients connected",
        };
      }

      if (
        snapshot.connectedClientCount > 1 ||
        snapshot.fanoutRecipientCount > 1 ||
        !targetClientId
      ) {
        return {
          ok: false,
          reasonCode: "multi_recipient_fanout",
          message: "Multiple downstream app clients connected",
        };
      }

      if (!readinessPublished) {
        return {
          ok: false,
          reasonCode: "registry_unavailable",
          message: "Automation registry is unavailable",
        };
      }

      emitDebug(
        "relay.protocol",
        "automation_registry_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          targetClientId,
        }),
      );

      return {
        ok: true,
        targetClientId,
        request: {},
      };
    },

    onAutomationState(clientId     , request     ) {

      const now = Date.now();
      const requestId =
        (typeof request.requestId === "string" && request.requestId.trim()) ||
        `automation-${now}-${Math.random().toString(16).slice(2, 8)}`;
      const requestedSessionKey =
        typeof request.sessionKey === "string" && request.sessionKey.trim()
          ? request.sessionKey.trim()
          : null;
      const snapshot =
        ctx.server && typeof ctx.server.getReadinessSnapshot === "function"
          ? ctx.server.getReadinessSnapshot()
          : {
              connectedClientCount: 0,
              fanoutRecipientCount: 0,
              clients: [],
            };
      const targetEntry =
        snapshot &&
        snapshot.connectedClientCount === 1 &&
        snapshot.fanoutRecipientCount === 1 &&
        Array.isArray(snapshot.clients) &&
        snapshot.clients.length === 1
          ? snapshot.clients[0]
          : null;
      const targetClientId =
        targetEntry && typeof targetEntry.clientId === "string"
          ? targetEntry.clientId
          : null;

      const readinessPublished =
        !!(
          targetEntry &&
          targetEntry.readinessSnapshot &&
          Number.isFinite(targetEntry.readinessSnapshot.emittedAtMs)
        );

      emitDebug(
        "relay.protocol",
        "automation_state_requested",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          requestedSessionKey,
          connectedClientCount:
            snapshot && Number.isFinite(snapshot.connectedClientCount)
              ? snapshot.connectedClientCount
              : 0,
          fanoutRecipientCount:
            snapshot && Number.isFinite(snapshot.fanoutRecipientCount)
              ? snapshot.fanoutRecipientCount
              : 0,
        }),
      );

      if (
        !snapshot ||
        snapshot.connectedClientCount <= 0 ||
        snapshot.fanoutRecipientCount <= 0
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "no_downstream_client",
          message: "No downstream app clients connected",
        };
      }

      if (
        snapshot.connectedClientCount > 1 ||
        snapshot.fanoutRecipientCount > 1 ||
        !targetClientId
      ) {
        return {
          ok: false,
          requestId,
          reasonCode: "multi_recipient_fanout",
          message: "Multiple downstream app clients connected",
        };
      }

      if (!readinessPublished) {
        return {
          ok: false,
          requestId,
          reasonCode: "snapshot_unavailable",
          message: "Automation state snapshot is unavailable",
        };
      }

      emitDebug(
        "relay.protocol",
        "automation_state_dispatched",
        "info",
        { sessionKey: sessionService.ensureSessionKey() },
        () => ({
          clientId,
          requestId,
          targetClientId,
        }),
      );

      return {
        ok: true,
        requestId,
        targetClientId,
        request: {
          requestId,
          sessionKey: requestedSessionKey,
        },
      };
    },
  };
}

module.exports = { createRelayToolingHandlers };
