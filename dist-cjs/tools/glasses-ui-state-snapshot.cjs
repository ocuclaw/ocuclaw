const { DELIVERY_RUNG_PHRASING, DELIVERY_RUNGS, assertHonestFieldName } = require("./glasses-ui-delivery-ladder.cjs");
const { MACHINE_PROJECTION_LIST_CAP, allowlistWireKind, capCodeList, resolveLayoutBudgets } = require("./glasses-ui-plan-lint.cjs");

const UI_STATE_SCHEMA_ID = "glasses-ui/state-snapshot@6";
const UI_STATE_SCHEMA_VERSION = 6;

const UI_STATE_RESULT = "ui_state";

const LINK_PRESENCE_STATES = Object.freeze([
  "connected",
  "disconnected",
  "unknown",
]);

const GLASSES_PRESENCE_STATES = Object.freeze([
  "worn",
  "absent",
  "in_case",
  "unknown",
]);

const BACKPRESSURE_STATES = Object.freeze([
  "nominal",
  "over_high_water",
  "unknown",
]);

const AGENT_TURN_STATES = Object.freeze(["idle", "busy", "unknown"]);

const SURFACE_MARKER_STATES = Object.freeze([
  "listening",
  "inflight",
  "parked",
]);

const STAGE_ROLES = Object.freeze([
  "holder",
  "backstage",
  "contender",
  "vacant",
]);

const LIVEUI_HOST_CAPABILITY_HOOKS = Object.freeze([
  Object.freeze({ capability: "render", hook: "relay.sendGlassesUiRender" }),
  Object.freeze({ capability: "surfaceUpdate", hook: "relay.sendGlassesUiSurfaceUpdate" }),
  Object.freeze({ capability: "resultChannel", hook: "relay.onGlassesUiResult" }),

  Object.freeze({ capability: "renderReceipts", hook: "relay.onGlassesUiRenderReceipt" }),
  Object.freeze({ capability: "lifecycleTrace", hook: "emitLifecycle" }),
  Object.freeze({ capability: "liveConfig", hook: "getGlassesUiLiveConfig" }),
  Object.freeze({ capability: "llmApiKey", hook: "resolveLlmApiKey" }),
  Object.freeze({ capability: "llmRecipe", hook: "executeLlmRecipe" }),
  Object.freeze({ capability: "sessionConnectivity", hook: "isSessionConnected" }),
  Object.freeze({ capability: "glassesPresence", hook: "relay.onGlassesPresenceChanged" }),
  Object.freeze({ capability: "backpressureSignal", hook: "isUnderBackpressure" }),
  Object.freeze({ capability: "wakeDispatch", hook: "dispatchWake" }),
  Object.freeze({ capability: "agentTurnBusy", hook: "isAgentTurnBusy" }),
  Object.freeze({ capability: "companionSnapshot", hook: "publishCompanionSnapshot" }),
]);

function readHookPath(port, path) {
  const parts = String(path).split(".");
  let cursor = port;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function buildHostCapabilityManifest(port) {
  const capabilities = {};
  for (const row of LIVEUI_HOST_CAPABILITY_HOOKS) {
    capabilities[row.capability] = typeof readHookPath(port, row.hook) === "function";
  }
  return capabilities;
}

const UI_STATE_MODEL_FIELDS = Object.freeze([
  "result",
  "schema",
  "schemaVersion",
  "sessionKey",
  "snapshotAtMs",
  "active",
  "stage",
  "stack",
  "marker",
  "pendingRender",
  "listening",
  "parkedEventCount",
  "deadLetterCount",
  "cron",
  "delivery",
  "renderContext",
  "readingProfile",
  "hostCapabilities",
]);

const UI_STATE_MACHINE_FIELDS = Object.freeze([
  "result",
  "schema",
  "schemaVersion",
  "sessionKey",
  "storeId",
  "snapshotAtMs",
  "active",
  "stage",
  "stack",
  "breadcrumb",
  "marker",
  "pendingRender",
  "listening",
  "parkedEventCount",
  "deadLetterCount",
  "cron",
  "delivery",
  "renderContext",
  "readingProfile",
  "hostCapabilities",
]);

const UI_STATE_COMPANION_FIELDS = UI_STATE_MACHINE_FIELDS;

const UI_STATE_DEV_FIELDS = Object.freeze([
  "result",
  "schema",
  "schemaVersion",
  "sessionKey",
  "storeId",
  "snapshotAtMs",
  "active",
  "stage",
  "stack",
  "breadcrumb",
  "marker",
  "pendingRender",
  "listening",
  "parkedEventCount",
  "deadLetterCount",
  "cron",
  "delivery",
  "deliveryEvidence",
  "renderContext",
  "readingProfile",
  "hostCapabilities",
  "activeSurfaceId",
]);

const UI_STATE_STRUCTURAL_EXCLUSIONS = Object.freeze([

  "body",
  "detailBody",
  "detailBodies",
  "items",
  "itemLabels",
  "labels",
  "lastBody",
  "lastItems",
  "lastContent",
  "spec",
  "recordedSpec",
  "imageBase64",
  "caption",

  "selectedValue",
  "selected_value",
  "selectedLabel",
  "selected_label",

  "conversation",
  "transcript",
  "messages",
  "prompt",
  "appendSystemContext",

  "apiKey",
  "token",
  "relayToken",
  "secret",
  "credentials",
  "authorization",
]);

const UI_STATE_COMPANION_EXCLUSIONS = Object.freeze([
  "spec",
  "recordedSpec",
  "imageBase64",
  "refresh",
  "recipe",
  "headers",
  "apiKey",
  "token",
  "relayToken",
  "secret",
  "credentials",
  "authorization",
]);

function projectByEnumeration(fields, facts) {
  const out = {};
  for (const field of fields) {
    if (facts && Object.prototype.hasOwnProperty.call(facts, field)) {
      const value = facts[field];
      if (value !== undefined) out[field] = value;
    }
  }
  return out;
}

function collectKeys(value, sink, depth) {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, sink, depth + 1);
    return;
  }
  for (const key of Object.keys(value)) {
    sink.add(key);
    collectKeys(value[key], sink, depth + 1);
  }
}

function assertUiStateExclusions(envelope, context) {
  const keys = new Set();
  collectKeys(envelope, keys, 0);
  for (const excluded of UI_STATE_STRUCTURAL_EXCLUSIONS) {
    if (keys.has(excluded)) {
      throw new Error(
        `${context || "ui-state envelope"}: field "${excluded}" is structurally excluded ` +
          "from the glasses-UI state snapshot (INV-A6 — companion/snapshot exclusions are " +
          "enumerated by schema, never filtered by convention). If a consumer genuinely " +
          "needs it, add it to the channel enumeration with a ruling, do not leak it.",
      );
    }
  }
  return true;
}

function assertCompanionSnapshotExclusions(envelope, context) {
  const keys = new Set();
  collectKeys(envelope, keys, 0);
  for (const excluded of UI_STATE_COMPANION_EXCLUSIONS) {
    if (keys.has(excluded)) {
      throw new Error(
        `${context || "companion snapshot"}: field "${excluded}" is excluded from the ` +
          "local companion artifact; retain wearer-visible content, never credentials or control inputs.",
      );
    }
  }
  return true;
}

function assertUiStateFieldNamesHonest(envelope, context) {
  const keys = new Set();
  collectKeys(envelope, keys, 0);
  for (const key of keys) {
    assertHonestFieldName(key, context || "ui-state envelope");
  }
  return true;
}

function deriveRenderContext(signals) {
  const s = signals || {};
  const presence =
    s.linkPresence === undefined || s.linkPresence === null
      ? "unknown"
      : s.linkPresence
        ? "connected"
        : "disconnected";
  const backpressure =
    s.backpressure === undefined || s.backpressure === null
      ? "unknown"
      : s.backpressure
        ? "over_high_water"
        : "nominal";
  const glassesPresence = GLASSES_PRESENCE_STATES.includes(s.glassesPresence)
    ? s.glassesPresence
    : "unknown";
  const agentTurn =
    s.agentTurnBusy === undefined || s.agentTurnBusy === null
      ? "unknown"
      : s.agentTurnBusy
        ? "busy"
        : "idle";
  return { linkPresence: presence, glassesPresence, backpressure, agentTurn };
}

function deriveReadingProfile(kind, opts) {
  const wireKind = allowlistWireKind(kind);
  if (!wireKind) {
    return {
      kind: null,
      budgets: {},
      provenanceByKey: {},
      budgetsMeasured: false,
      source: null,
    };
  }
  const resolved = resolveLayoutBudgets({ kind: wireKind }, null, opts || {});
  return {
    kind: wireKind,
    budgets: { ...resolved.budgets },
    provenanceByKey: { ...resolved.provenanceByKey },
    budgetsMeasured: Boolean(resolved.registrySourcesMeasured),
    source: resolved.source || null,
  };
}

function projectDelivery(deliveryState, receiptPresent) {
  if (!deliveryState) {
    return {
      rung: null,
      phrase: null,
      surfaceUuid: null,
      lastAttemptedSend: null,
      lastPaintedAt: null,
      clientReceiptPresent: false,
    };
  }
  const attempt = deliveryState.lastAttemptedSend;
  return {
    rung: deliveryState.rung,
    phrase: deliveryState.phrase,
    surfaceUuid: deliveryState.surfaceUuid,

    lastAttemptedSend: attempt
      ? { seq: attempt.seq, atMs: attempt.atMs, mode: attempt.mode }
      : null,
    lastPaintedAt: deliveryState.lastPaintedAt === undefined ? null : deliveryState.lastPaintedAt,
    clientReceiptPresent: Boolean(receiptPresent),
  };
}

function projectUiStateChannels(facts) {
  const f = facts || {};
  const active = f.active || null;
  const shared = {
    result: UI_STATE_RESULT,
    schema: UI_STATE_SCHEMA_ID,
    schemaVersion: UI_STATE_SCHEMA_VERSION,
    sessionKey: f.sessionKey || null,
    storeId: f.storeId || null,
    snapshotAtMs: f.snapshotAtMs,
    marker: f.marker || null,
    pendingRender: Boolean(f.pendingRender),
    listening: Boolean(f.listening),
    parkedEventCount: f.parkedEventCount || 0,
    deadLetterCount: f.deadLetterCount || 0,
    cron: f.cron || null,
    delivery: f.delivery || null,
    deliveryEvidence: f.deliveryEvidence || null,
    renderContext: f.renderContext || null,
    readingProfile: f.readingProfile || null,
    hostCapabilities: f.hostCapabilities || null,
    breadcrumb: f.breadcrumb === undefined ? null : f.breadcrumb,
    activeSurfaceId: f.activeSurfaceId === undefined ? null : f.activeSurfaceId,
  };

  const rawStage = f.stage || {};
  const stageRole = STAGE_ROLES.includes(rawStage.role) ? rawStage.role : "vacant";
  const modelStage = {
    role: stageRole,
    holderMarker: SURFACE_MARKER_STATES.includes(rawStage.holderMarker)
      ? rawStage.holderMarker
      : null,
    graceRemainingMs: Number.isFinite(rawStage.graceRemainingMs)
      ? rawStage.graceRemainingMs
      : null,
  };
  const machineStage = {
    ...modelStage,
    holderSessionKey:
      typeof rawStage.holderSessionKey === "string" ? rawStage.holderSessionKey : null,
    holderSurfaceUuid:
      typeof rawStage.holderSurfaceUuid === "string" ? rawStage.holderSurfaceUuid : null,
    generation: Number.isFinite(rawStage.generation) ? rawStage.generation : null,
  };
  const devStage = {
    ...machineStage,
    holderSurfaceId:
      typeof rawStage.holderSurfaceId === "string" ? rawStage.holderSurfaceId : null,
    grantedAtMs: Number.isFinite(rawStage.grantedAtMs) ? rawStage.grantedAtMs : null,
    busySinceMs: Number.isFinite(rawStage.busySinceMs) ? rawStage.busySinceMs : null,
  };

  const modelActive = active
    ? {
        surfaceUuid: active.surfaceUuid,
        kind: allowlistWireKind(active.kind),
        titleChars: typeof active.title === "string" ? active.title.length : 0,
        state: active.state,
        terminationCause: active.terminationCause || null,
        marker: active.marker,
        queueMode: active.queueMode,
        staleAfterMs: active.staleAfterMs === undefined ? null : active.staleAfterMs,
        lastRender: active.lastRender || null,
      }
    : null;
  const companionActive = active
    ? {
        surfaceUuid: active.surfaceUuid,
        kind: allowlistWireKind(active.kind),
        title: typeof active.title === "string" ? active.title : null,
        titleChars: typeof active.title === "string" ? active.title.length : 0,
        state: active.state,
        terminationCause: active.terminationCause || null,
        marker: active.marker,
        queueMode: active.queueMode,
        staleAfterMs: active.staleAfterMs === undefined ? null : active.staleAfterMs,
        lastRender: active.lastRender || null,
      }
    : null;
  const localCompanionActive = companionActive
    ? {
        ...companionActive,
        content:
          active.content && typeof active.content === "object"
            ? active.content
            : null,
      }
    : null;

  const rawStack = Array.isArray(f.stack) ? f.stack : [];
  const modelStack = {
    depth: f.stackDepth || 0,
    entries: capCodeList(
      rawStack.map((e) => ({
        surfaceUuid: e.surfaceUuid,
        kind: allowlistWireKind(e.kind),
        titleChars: typeof e.title === "string" ? e.title.length : 0,
      })),
    ),
    entryCap: MACHINE_PROJECTION_LIST_CAP,
  };
  const companionStack = {
    depth: f.stackDepth || 0,
    entries: capCodeList(
      rawStack.map((e) => ({
        surfaceUuid: e.surfaceUuid,
        kind: allowlistWireKind(e.kind),
        title: typeof e.title === "string" ? e.title : null,
        titleChars: typeof e.title === "string" ? e.title.length : 0,
      })),
    ),
    entryCap: MACHINE_PROJECTION_LIST_CAP,
  };

  const model = projectByEnumeration(UI_STATE_MODEL_FIELDS, {
    ...shared,
    active: modelActive,
    stage: modelStage,
    stack: modelStack,
  });
  const machine = projectByEnumeration(UI_STATE_MACHINE_FIELDS, {
    ...shared,
    active: companionActive,
    stage: machineStage,
    stack: companionStack,
  });
  const companion = projectByEnumeration(UI_STATE_COMPANION_FIELDS, {
    ...shared,
    active: localCompanionActive,
    stage: machineStage,
    stack: companionStack,
  });
  const dev = projectByEnumeration(UI_STATE_DEV_FIELDS, {
    ...shared,
    active: companionActive,
    stage: devStage,
    stack: companionStack,
  });

  for (const [name, channel] of [
    ["model", model],
    ["machine", machine],
    ["dev", dev],
  ]) {
    assertUiStateExclusions(channel, `ui-state ${name} channel`);
    assertUiStateFieldNamesHonest(channel, `ui-state ${name} channel`);
  }

  assertCompanionSnapshotExclusions(companion, "ui-state local companion channel");
  assertUiStateFieldNamesHonest(companion, "ui-state local companion channel");

  return { model, machine, dev, companion };
}

function emptyUiStateFacts(sessionKey, extra) {
  const e = extra || {};
  return {
    sessionKey: sessionKey || null,
    storeId: e.storeId || null,
    snapshotAtMs: e.snapshotAtMs,
    active: null,
    stage: e.stage || {
      role: "vacant",
      holderSessionKey: null,
      holderSurfaceId: null,
      holderSurfaceUuid: null,
      holderMarker: null,
      generation: null,
      grantedAtMs: null,
      busySinceMs: null,
      graceRemainingMs: null,
    },
    stack: [],
    stackDepth: 0,
    breadcrumb: null,
    marker: null,
    pendingRender: false,
    listening: false,
    parkedEventCount: 0,
    deadLetterCount: Number.isFinite(e.deadLetterCount) ? e.deadLetterCount : 0,
    cron: { active: false, paused: false, ticks: null, lastRender: null },
    delivery: projectDelivery(null, false),
    deliveryEvidence: null,
    renderContext: e.renderContext || deriveRenderContext(null),
    readingProfile: e.readingProfile || deriveReadingProfile(null, null),
    hostCapabilities: e.hostCapabilities || null,
    activeSurfaceId: null,
  };
}

const UI_STATE_UNSENT_RUNG = DELIVERY_RUNGS.AUTHORED;

const UI_STATE_RUNG_PHRASING = DELIVERY_RUNG_PHRASING;

module.exports = { UI_STATE_SCHEMA_ID, UI_STATE_SCHEMA_VERSION, UI_STATE_RESULT, LINK_PRESENCE_STATES, BACKPRESSURE_STATES, AGENT_TURN_STATES, SURFACE_MARKER_STATES, LIVEUI_HOST_CAPABILITY_HOOKS, buildHostCapabilityManifest, UI_STATE_MODEL_FIELDS, UI_STATE_MACHINE_FIELDS, UI_STATE_COMPANION_FIELDS, UI_STATE_DEV_FIELDS, UI_STATE_STRUCTURAL_EXCLUSIONS, UI_STATE_COMPANION_EXCLUSIONS, projectByEnumeration, assertUiStateExclusions, assertCompanionSnapshotExclusions, assertUiStateFieldNamesHonest, deriveRenderContext, deriveReadingProfile, projectDelivery, projectUiStateChannels, emptyUiStateFacts, UI_STATE_UNSENT_RUNG, UI_STATE_RUNG_PHRASING };
