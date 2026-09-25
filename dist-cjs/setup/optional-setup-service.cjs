const crypto = require("node:crypto");

const fs = require("node:fs");
const { planOptionalSetupActivation } = require("./optional-activation-policy.cjs");
const { resolveHostConfigPath } = require("./relay-credential-provision.cjs");
const { optionalPluginConfig, saveOptionalCredential } = require("./optional-credential-store.cjs");
const { parseOptionalSetupRequest, optionalSetupFailure, optionalSetupResult } = require("./optional-setup-protocol.cjs");
const { OPENCLAW_BUNDLE_DEFAULT_WS_PORT } = require("../config/runtime-config.cjs");
const { createOptionalDiagnosticsCommand } = require("./optional-diagnostics-command.cjs");
const { createOptionalEvenAiRouteService } = require("./optional-even-ai-route.cjs");

function createOptionalSetupService(api     , dependencies      = {}) {
  const now = dependencies.now || Date.now;
  let generation = crypto.randomUUID();
  let observedSignature = "";
  const salt = crypto.randomBytes(32);
  const transactions = new Map();
  const activations = new Map();
  const disconnected = new Set();

  const fields      = { soniox: "sonioxApiKey", even_ai: "evenAiToken", typesafe: "typesafeApiKey" };
  let saving = false;
  const configApi = api?.runtime?.config;
  const routes = createOptionalEvenAiRouteService(api, { ...dependencies.route, now, readJourney: dependencies.readJourney });
  const supported = () => typeof configApi?.current === "function" && typeof configApi?.mutateConfigFile === "function";
  function readCoreComplete() {

    try {
      const record = dependencies.readFirstUse?.();
      if (!record || !["awaiting-reply", "awaiting-confirmation", "awaiting-welcome", "completed"].includes(record.status)) return null;
      return record.status === "completed" && record.confirmation?.source !== "test-input";
    } catch (_) { return null; }
  }
  function revision(document     ) {
    const config = optionalPluginConfig(document);

    const guarded = { sonioxApiKey: config.sonioxApiKey || "", evenAiToken: config.evenAiToken || "",
      typesafeApiKey: config.typesafeApiKey || "",
      evenAiEnabled: config.evenAiEnabled === true, relayToken: config.relayToken || "",
      access: config.externalDebugToolsEnabled === true, handoff: config.allowDebugUpload === true,
      wsPort: config.wsPort === undefined ? OPENCLAW_BUNDLE_DEFAULT_WS_PORT : config.wsPort,
      policy: planOptionalSetupActivation(document, api?.runtime?.version) };
    return crypto.createHmac("sha256", salt).update(JSON.stringify(guarded)).digest("hex");
  }

  function readDiskDocument() {
    if (typeof dependencies.readDiskConfig === "function") return dependencies.readDiskConfig();
    const configPath = resolveHostConfigPath(api, (globalThis       ).process?.env);
    if (!configPath) return null;
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }

  function hasInclude(node     , depth     )      {
    if (!node || typeof node !== "object") return false;
    if (depth > 64) return true;
    if (!Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, "$include")) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) if (hasInclude(child, depth + 1)) return true;
    return false;
  }
  function readSavedDocument() {
    try {
      const document = readDiskDocument();
      if (!document || typeof document !== "object" || Array.isArray(document)) return configApi.current();

      if (hasInclude(document, 0)) return configApi.current();
      const config = optionalPluginConfig(document);
      for (const field of ["sonioxApiKey", "evenAiToken"]) {
        const value = config[field];
        if (value !== undefined && (typeof value !== "string" || value.includes("${"))) return configApi.current();
      }
      for (const field of ["evenAiEnabled", "externalDebugToolsEnabled", "allowDebugUpload"]) {
        if (config[field] !== undefined && typeof config[field] !== "boolean") return configApi.current();
      }
      return document;
    } catch (_) { return configApi.current(); }
  }
  function read() {
    const document = readSavedDocument();
    const config = optionalPluginConfig(document);
    for (const field of ["sonioxApiKey", "evenAiToken", "typesafeApiKey"]) if (config[field] !== undefined && typeof config[field] !== "string") throw new Error("configuration_unknown");
    if (config.evenAiEnabled !== undefined && typeof config.evenAiEnabled !== "boolean") throw new Error("configuration_unknown");
    for (const field of ["externalDebugToolsEnabled", "allowDebugUpload"]) if (config[field] !== undefined && typeof config[field] !== "boolean") throw new Error("configuration_unknown");
    const loaded = typeof dependencies.readLoaded === "function" ? dependencies.readLoaded() : null;
    const currentRevision = revision(document);
    const signature = crypto.createHmac("sha256", salt).update(JSON.stringify({ currentRevision,
      loaded: loaded ? { sonioxApiKey: loaded.sonioxApiKey || "", evenAiToken: loaded.evenAiToken || "",
        typesafeApiKey: loaded.typesafeApiKey || "",
        evenAiEnabled: loaded.evenAiEnabled === true, access: loaded.externalDebugToolsEnabled === true,
        handoff: loaded.allowDebugUpload === true } : null })).digest("hex");
    if (signature !== observedSignature) { observedSignature = signature; generation = crypto.randomUUID(); }
    const plan = planOptionalSetupActivation(document, api?.runtime?.version);
    const capabilities      = {};
    for (const capability of Object.keys(fields)) {
      const field = fields[capability];
      const present = typeof config[field] === "string" && !!config[field].trim();
      const active = loaded && loaded[field] === config[field] && (capability !== "even_ai" || (config.evenAiEnabled === true && loaded.evenAiEnabled === true));
      capabilities[capability] = { present, state: !present ? "not_configured" : active ? "available_to_test" : "saved" };
    }
    const required = Object.values(capabilities).some((row     ) => row.present && row.state !== "available_to_test");

    let running = plan;
    try { running = planOptionalSetupActivation(configApi.current(), api?.runtime?.version); } catch (_) {  }
    const hot = running.afterWrite.mode === "auto";
    return { document, config, revision: currentRevision, plan, snapshot: { runtime: "openclaw", generation, capabilities, coreComplete: readCoreComplete(),
      activation: { supported: hot, required, mode: hot ? "hot_reload" : "manual", affectsAllProfiles: false },
      diagnostics: { supported: true, access: config.externalDebugToolsEnabled === true, handoff: config.allowDebugUpload === true,
        activeAccess: loaded ? loaded.externalDebugToolsEnabled === true : null,
        activeHandoff: loaded ? loaded.allowDebugUpload === true : null } } };
  }
  function prune() {
    for (const [key, row] of transactions) if (row.expiresAtMs <= now()) transactions.delete(key);
    for (const [key, row] of activations) if (row.expiresAtMs <= now()) activations.delete(key);
  }
  async function handle(value     , context     ) {
    const request = parseOptionalSetupRequest(value);
    if (!request) return optionalSetupFailure(value, "invalid_request");
    const connectionId = context?.connectionId;
    if (typeof connectionId !== "string" || !connectionId || connectionId.length > 256 || disconnected.has(connectionId)) return optionalSetupFailure(request, "not_connected");
    if (!supported()) return optionalSetupFailure(request, "unsupported", "unsupported");
    prune();
    const reply = (result     ) => optionalSetupResult(request, result);
    try {
      const current = read();
      if (request.operation === "status") return reply({ status: "ok", snapshot: current.snapshot });
      if (request.operation.startsWith("route.")) {
        const mutates = request.operation === "route.apply";
        if (saving) return optionalSetupFailure(request, "busy");
        if (mutates) saving = true;
        try {
          const result = await routes.handle(request, connectionId, { revision: current.revision,
            fresh: () => !disconnected.has(connectionId) && revision(readSavedDocument()) === current.revision });
          return reply({ ...result, snapshot: read().snapshot });
        } finally { if (mutates) saving = false; }
      }
      if (request.operation === "diagnostics.preview") {
        if (activations.size >= 64) return optionalSetupFailure(request, "busy");
        const diagnostics = { operationId: crypto.randomUUID(), expiresAtMs: now() + 120000,
          permission: request.permission, allowed: request.allowed, state: "preview" };
        activations.set(diagnostics.operationId, { ...diagnostics, connectionId, revision: current.revision, applied: false, kind: "diagnostics" });
        return reply({ status: "ok", snapshot: current.snapshot, diagnostics });
      }
      if (request.operation === "diagnostics.apply") {
        const diagnostics = activations.get(request.operationId);
        if (!diagnostics || diagnostics.kind !== "diagnostics" || diagnostics.connectionId !== connectionId || diagnostics.applied) return optionalSetupFailure(request, "operation_unknown");
        diagnostics.applied = true;
        if (saving) return optionalSetupFailure(request, "busy");
        if (diagnostics.revision !== current.revision) return optionalSetupFailure(request, "configuration_changed");
        saving = true;
        try {
          const result = await createOptionalDiagnosticsCommand(api, {
            checkDraft: (draft     ) => !disconnected.has(connectionId) && revision(draft) === diagnostics.revision,
          })(diagnostics.permission, diagnostics.allowed ? "allow" : "deny");
          diagnostics.state = result.status === "saved" ? "saved" : "unknown";
          return reply({ status: diagnostics.state === "saved" ? "saved" : "outcome_unknown", snapshot: read().snapshot, diagnostics });
        } finally { saving = false; }
      }
      if (request.operation === "credential.begin") {
        if (saving || transactions.size >= 64) return optionalSetupFailure(request, "busy");
        const field = fields[request.capability];
        if (current.config[field] && request.intent !== "replace") return reply({ status: "preserved", code: "replacement_required", snapshot: current.snapshot });
        for (const [key, row] of transactions) if (row.connectionId === connectionId) transactions.delete(key);
        const transaction = { id: crypto.randomUUID(), expiresAtMs: now() + 120000, capability: request.capability, intent: request.intent };
        transactions.set(transaction.id, { ...transaction, connectionId, revision: current.revision });
        return reply({ status: "ok", snapshot: current.snapshot, transaction });
      }
      if (request.operation === "credential.cancel" || request.operation === "credential.save") {
        const transaction = transactions.get(request.transactionId);
        if (!transaction || transaction.connectionId !== connectionId) return optionalSetupFailure(request, "transaction_invalid");
        transactions.delete(request.transactionId);
        if (request.operation === "credential.cancel") return reply({ status: "cancelled", snapshot: current.snapshot });
        if (saving) return optionalSetupFailure(request, "busy");
        if (transaction.revision !== current.revision) return optionalSetupFailure(request, "configuration_changed");
        saving = true;
        try {
          const field = fields[transaction.capability];
          const saved = await saveOptionalCredential(api, field, request.credential, {
            previous: current.config[field], activationPlan: current.plan, enableEvenAi: transaction.capability === "even_ai",
            checkDraft: (draft     ) => !disconnected.has(connectionId) && revision(draft) === transaction.revision,
          });
          if (!saved) return optionalSetupFailure(request, "save_unconfirmed", "outcome_unknown");
          return reply({ status: "saved", snapshot: read().snapshot });
        } catch (err     ) {

          api?.logger?.warn?.(`[ocuclaw] optional-setup credential.save (${transaction.capability}) failed: ${err && err.message ? err.message : String(err)}`);
          return optionalSetupFailure(request, "save_unconfirmed", "outcome_unknown");
        } finally { request.credential = ""; saving = false; }
      }
      if (request.operation === "activation.preview") {
        if (activations.size >= 64) return optionalSetupFailure(request, "busy");
        const activation = { operationId: crypto.randomUUID(), expiresAtMs: now() + 120000,
          mode: current.snapshot.activation.mode, affectsAllProfiles: false,
          state: !current.snapshot.activation.required ? "complete" : current.snapshot.activation.supported ? "preview" : "unsupported" };
        activations.set(activation.operationId, { ...activation, connectionId, revision: current.revision, applied: false });
        return reply({ status: activation.state === "unsupported" ? "unsupported" : "ok", snapshot: current.snapshot, activation });
      }
      const activation = activations.get(request.operationId);
      if (!activation || activation.kind === "diagnostics") return optionalSetupFailure(request, "operation_unknown");
      if (request.operation === "activation.apply") {
        if (activation.connectionId !== connectionId || activation.applied) return optionalSetupFailure(request, "operation_unknown");
        activation.applied = true;
        if (activation.revision !== current.revision) return optionalSetupFailure(request, "configuration_changed");

        activation.state = !current.snapshot.activation.required ? "complete" : current.snapshot.activation.supported ? "pending" : "unsupported";
      } else {
        activation.state = !current.snapshot.activation.required ? "complete" : activation.state === "unsupported" ? "unsupported" : "pending";
      }
      return reply({ status: activation.state === "unsupported" ? "unsupported" : "ok", snapshot: current.snapshot, activation });
    } catch (err     ) {
      api?.logger?.warn?.(`[ocuclaw] optional-setup ${request?.operation || "request"} failed: ${err && err.message ? err.message : String(err)}`);
      return optionalSetupFailure(request, "unavailable", "outcome_unknown");
    }
  }
  return { handle, disconnect(connectionId     ) {
    routes.disconnect(connectionId);
    disconnected.add(connectionId);
    if (disconnected.size > 256) disconnected.delete(disconnected.values().next().value);
    for (const [key, row] of transactions) if (row.connectionId === connectionId) transactions.delete(key);
    for (const [key, row] of activations) if (row.connectionId === connectionId && !row.applied) activations.delete(key);
  } };
}

module.exports = { createOptionalSetupService };
