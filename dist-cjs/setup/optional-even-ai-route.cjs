const fs = require("node:fs");

const path = require("node:path");

const { randomUUID } = require("node:crypto");
const { planEvenAiRoute, readEvenAiHostContext } = require("./even-ai-setup-command.cjs");
const { defaultRunTailscale, readNodeState, readServeStatus, resolveHostStateDir, READ_OK } = require("./private-route.cjs");
const { optionalPluginConfig } = require("./optional-credential-store.cjs");
const { OPENCLAW_BUNDLE_DEFAULT_WS_PORT } = require("../config/runtime-config.cjs");

function stable(value     )         {
  if (Array.isArray(value)) return JSON.stringify(value.map((entry) => JSON.parse(stable(entry))));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map((key) => [key, JSON.parse(stable(value[key]))])));
  return JSON.stringify(value === undefined ? null : value);
}

function unrelatedGraph(document     ) {
  const copy = JSON.parse(JSON.stringify(document));
  delete copy.ETag;
  for (const table of ["TCP", "Web"]) {
    copy[table] = { ...(copy[table] || {}) };
    for (const key of Object.keys(copy[table])) if (key.split(":").pop() === "8443") delete copy[table][key];
  }
  return stable(copy);
}

function createOptionalEvenAiRouteService(api     , deps      = {}) {
  const now = deps.now || Date.now;
  const rows = new Map();
  const run = deps.runTailscale || defaultRunTailscale;
  const readHost = deps.readHostContext || ((journey     ) => readEvenAiHostContext(journey, deps));
  let applying = false;

  async function observe() {
    if (typeof deps.readJourney !== "function") throw new Error("unsupported");
    const journey = await deps.readJourney();
    const port = journey?.currentHealth?.privateRoute?.relay?.port;
    const config = optionalPluginConfig(api.runtime.config.current());
    const savedPort = config.wsPort === undefined ? OPENCLAW_BUNDLE_DEFAULT_WS_PORT : config.wsPort;
    if (!journey?.installation?.id || journey.currentHealth?.relay !== "running" || journey.currentHealth?.privateRoute?.relay?.status !== "running"
        || !Number.isInteger(port) || port < 1 || port > 65535 || port !== savedPort) throw new Error("unavailable");
    const host = await readHost(journey);

    if (!host?.cliArgv) throw new Error("unavailable");
    let nodeIdentity      = null;
    const read = async (args     ) => {
      const result      = await run(args, host.cliArgv);
      if (args[0] === "status" && result?.code === READ_OK) {
        try {
          const self = JSON.parse(result.stdout)?.Self;
          if (typeof self?.ID === "string" && self.ID) nodeIdentity = { id: self.ID,
            publicKey: typeof self.PublicKey === "string" ? self.PublicKey : null,
            addresses: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [] };
        } catch (_) {  }
      }
      return result;
    };
    const [serve, node]      = await Promise.all([readServeStatus(read), readNodeState(read)]);
    if (!nodeIdentity) throw new Error("unavailable");
    const latest = await deps.readJourney();
    const latestHost = await readHost(latest);
    if (latest?.installation?.id !== journey.installation.id || latest.currentHealth?.relay !== "running"
        || latest.currentHealth?.privateRoute?.relay?.status !== "running" || latest.currentHealth?.privateRoute?.relay?.port !== port
        || stable(latestHost) !== stable(host)) throw new Error("context_changed");
    const context = { ...node, ...host, runtime: "openclaw", relayPort: port };
    const decision = planEvenAiRoute(serve.document, context);
    return { identity: { installationId: journey.installation.id, port, host, node, nodeIdentity }, document: serve.document, decision };
  }

  function publicRoute(row     , observation      = null, state      = null, reason      = null) {
    const seen = observation || row.observation;
    const decision = seen?.decision;
    const endpoint = decision?.agentUrl || null;
    return { operationId: row.id, expiresAtMs: row.expiresAtMs,
      state: state || (decision?.status === "proposal" ? "preview" : decision?.status === "ready" ? "ready" : "refused"),
      reason: reason || (decision?.status === "proposal" ? "route_absent" : decision?.status === "ready" ? "route_matches" : "route_conflict"),
      host: endpoint ? seen.identity.node.dnsName : null, agentUrl: endpoint,
      relayPort: endpoint ? seen.identity.port : null, tailnetOnly: true, requestVerified: false };
  }

  async function handle(request     , connectionId     , guard     ) {
    for (const [key, row] of rows) if (row.expiresAtMs <= now()) rows.delete(key);
    if (request.operation === "route.preview") {
      if (rows.size >= 64) return { status: "rejected", code: "busy" };
      const row      = { id: randomUUID(), expiresAtMs: now() + 120000, connectionId, revision: guard.revision, applied: false };
      try {
        row.observation = await observe();
        if (!guard.fresh()) return { status: "rejected", code: "configuration_changed" };
        rows.set(row.id, row);
        return { status: "ok", route: publicRoute(row) };
      } catch (_) { return { status: "unsupported", code: "unavailable", route: publicRoute(row, null, "unknown", "route_unavailable") }; }
    }
    const row = rows.get(request.operationId);
    if (!row || row.connectionId !== connectionId) return { status: "rejected", code: "operation_unknown" };
    if (request.operation === "route.status") {
      try {
        const current = await observe();
        if (!guard.fresh() || guard.revision !== row.revision || stable(current.identity) !== stable(row.observation.identity)) {
          return { status: "ok", route: publicRoute(row, null, "unknown", "context_changed") };
        }
        if (row.applied && (current.decision.status !== "ready" || unrelatedGraph(current.document) !== unrelatedGraph(row.observation.document))) {
          return { status: "outcome_unknown", route: publicRoute(row, null, "unknown", "apply_unconfirmed") };
        }
        return { status: "ok", route: publicRoute(row, current) };
      } catch (_) { return { status: "outcome_unknown", route: publicRoute(row, null, "unknown", "route_unavailable") }; }
    }
    if (row.applied) return { status: "rejected", code: "operation_unknown" };
    row.applied = true;
    if (applying) return { status: "rejected", code: "busy" };
    applying = true;
    let lock      = null;
    let lockPath      = null;
    try {
      const directory = deps.hostStateDir || resolveHostStateDir();
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      lockPath = path.join(directory, "ocuclaw.optional-even-ai-route.lock");
      lock = fs.openSync(lockPath, "wx", 0o600);
      const current = await observe();
      if (!guard.fresh() || guard.revision !== row.revision || row.expiresAtMs <= now()
          || stable(current) !== stable(row.observation)) return { status: "rejected", route: publicRoute(row, null, "refused", "context_changed") };
      if (current.decision.status === "ready") return { status: "ok", route: publicRoute(row, current) };
      if (current.decision.status !== "proposal") return { status: "rejected", route: publicRoute(row, current) };

      try {
        await run(["serve", "--bg", "--https=8443", `http://127.0.0.1:${current.identity.port}`], current.identity.host.cliArgv);
      } catch (_) {  }
      const after = await observe();
      if (!guard.fresh() || stable(after.identity) !== stable(current.identity)
          || after.decision.status !== "ready" || unrelatedGraph(after.document) !== unrelatedGraph(current.document)) {
        return { status: "outcome_unknown", route: publicRoute(row, null, "unknown", "apply_unconfirmed") };
      }
      return { status: "ok", route: publicRoute(row, after) };
    } catch (_) { return { status: "outcome_unknown", route: publicRoute(row, null, "unknown", "apply_unconfirmed") }; }
    finally {
      if (lock !== null) { fs.closeSync(lock); try { fs.unlinkSync(lockPath); } catch (_) {  } }
      applying = false;
    }
  }
  return { handle, disconnect(connectionId     ) { for (const [key, row] of rows) if (row.connectionId === connectionId) rows.delete(key); } };
}

module.exports = { createOptionalEvenAiRouteService };
