const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const process = require("node:process");
const { planOptionalSetupActivation } = require("./optional-activation-policy.cjs");
const { OPENCLAW_BUNDLE_DEFAULT_WS_PORT } = require("../config/runtime-config.cjs");
const { canonicalizeRelayAddressV1 } = require("../domain/pairing/relay-address.cjs");
const { defaultRunTailscale, normalizeDnsName, readJsonReceipt, readNodeState, readServeStatus, readTailscaleCliReceipt, resolveHostStateDir, tailscaleCommandPrefix, TAILSCALE_CLI_RECEIPT_FILENAME } = require("./private-route.cjs");

const record = (value     ) => value !== null && typeof value === "object" && !Array.isArray(value);
const portNumber = (value     ) => Number.isInteger(value) && value > 0 && value <= 65535;
const pluginConfig = (config     ) => config?.plugins?.entries?.ocuclaw?.config;

const effectiveRelayPort = (config     ) => config?.wsPort === undefined ? OPENCLAW_BUNDLE_DEFAULT_WS_PORT : config.wsPort;

const EVEN_AI_CUSTOM_ROUTE_NOTE =
  "Even AI uses your phone address (phoneAddress) too. The phone must be on that private network, and your front door must forward everything at that address to OcuClaw, not only the phone's WebSocket.";
const EVEN_AI_TAILSCALE_ROUTE_NOTE =
  "Your phone address (phoneAddress) is a Tailscale name, so the optional Even AI route uses Tailscale Serve on :8443 on this host.";
const EVEN_AI_INVALID_ADDRESS_NOTE =
  "Your phone address (phoneAddress) is not a valid wss://name:port address, so no Even AI URL can be built from it. Fix it, or clear it to use Tailscale.";

const PHONE_ROUTE_PORTS = [["hermes", 8446], ["openclaw", 8444]];
const LOOPBACK_PROXY = /^http:\/\/(127\.0\.0\.1|localhost):([0-9]{1,5})$/;

function customEvenAiAgentUrl(phoneAddress     ) {
  const checked      = canonicalizeRelayAddressV1(typeof phoneAddress === "string" ? phoneAddress.trim() : phoneAddress);
  if (!checked.ok) return null;
  const authority = checked.address.slice("wss://".length);
  const host = authority.slice(0, authority.lastIndexOf(":"));
  if (host === "ts.net" || host.endsWith(".ts.net")) return null;
  return `https://${authority.slice(host.length + 1) === "443" ? host : authority}/v1/chat/completions`;
}

function phoneRouteRuntime(document     , dns     , proxy     , self     ) {
  const target = LOOPBACK_PROXY.exec(typeof proxy === "string" ? proxy : "");
  if (!target) return null;
  for (const [name, port] of PHONE_ROUTE_PORTS) {
    const entry = (document.TCP || {})[String(port)];
    if (name === self || !record(entry) || entry.ProxyProtocol || normalizeDnsName(entry.TerminateTLS) !== dns) continue;
    if (entry.TCPForward === `127.0.0.1:${Number(target[2])}`) return name;
  }
  return null;
}
const tokenPresent = (config     ) => typeof config?.evenAiToken === "string" && !!config.evenAiToken.trim();
const validConfig = (config     ) => record(config)
  && (config.evenAiToken === undefined || typeof config.evenAiToken === "string")
  && (config.evenAiEnabled === undefined || typeof config.evenAiEnabled === "boolean")
  && (config.wsPort === undefined || portNumber(config.wsPort));
const validCli = (argv     ) => Array.isArray(argv) && argv.length >= 1 && argv.length <= 2
  && argv.every((part     ) => typeof part === "string" && part.length > 0 && !/[\x00-\x1f]/.test(part))
  && path.isAbsolute(argv[0])
  && (argv.length === 1 || (argv[1].startsWith("--socket=") && path.isAbsolute(argv[1].slice(9))));

const pathEnv = () => ({ PATH: process.env.PATH });

function resolveEvenAiLocalCli(env      = pathEnv()) {

  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const binary = path.join(directory, process.platform === "win32" ? "tailscale.exe" : "tailscale");
    try {
      fs.accessSync(binary, fs.constants.X_OK);
      if (fs.statSync(binary).isFile()) return [binary];
    } catch (_) {  }
  }
  return null;
}

function readEvenAiHostContext(journey     , deps      = {}) {
  const directory = deps.hostStateDir || resolveHostStateDir();
  const raw = readJsonReceipt(path.join(directory, TAILSCALE_CLI_RECEIPT_FILENAME));
  const cli = readTailscaleCliReceipt(directory);

  if (raw.status !== "missing" && !cli) return null;
  if (cli && (!Array.isArray(raw.record?.argv) || raw.record.argv.length !== cli.argv.length)) return null;
  if (!cli && journey?.host?.managed === "cloudways") return null;
  const cliArgv = cli ? cli.argv : resolveEvenAiLocalCli(deps.env || pathEnv());
  return cliArgv ? { cliArgv } : null;
}

function evenAiHostCliProblem(journey     , deps      = {}) {
  const directory = deps.hostStateDir || resolveHostStateDir();
  if (readJsonReceipt(path.join(directory, TAILSCALE_CLI_RECEIPT_FILENAME)).status !== "missing") return null;
  return journey?.host?.managed === "cloudways" || !resolveEvenAiLocalCli(deps.env || pathEnv()) ? "not_installed" : null;
}

function planEvenAiRoute(document     , context     ) {
  const dns = normalizeDnsName(context?.dnsName);
  const refuse = (reason     ) => ({ status: "refused", reason, command: null, agentUrl: null });
  if (!dns || context?.network !== "online") return refuse("tailnet_identity_unavailable");
  if (!portNumber(context?.relayPort) || context?.runtime !== "openclaw") return refuse("runtime_context_unavailable");
  if (!validCli(context?.cliArgv)) return refuse("tailscale_context_unavailable");
  if (!record(document) || Object.keys(document).some((key) => !["TCP", "Web", "AllowFunnel", "ETag", "Services", "Foreground"].includes(key))) return refuse("serve_state_ambiguous");
  for (const key of ["TCP", "Web", "AllowFunnel", "Services", "Foreground"]) {
    if (document[key] !== undefined && !record(document[key])) return refuse("serve_state_ambiguous");
  }

  if (Object.keys(document.Services || {}).length) return refuse("serve_services_ambiguous");
  for (const session of Object.values(document.Foreground || {})) {
    if (!record(session)) return refuse("foreground_state_ambiguous");
    const foreground      = session;
    if (Object.keys(foreground).some((key) => !["TCP", "Web", "AllowFunnel"].includes(key))) return refuse("foreground_state_ambiguous");
    for (const key of ["TCP", "Web", "AllowFunnel"]) {
      if (foreground[key] !== undefined && !record(foreground[key])) return refuse("foreground_state_ambiguous");
      if (Object.keys(foreground[key] || {}).some((name) => name.split(":").pop() === "8443")) return refuse("foreground_route");
    }
  }
  for (const [key, value] of Object.entries(document.AllowFunnel || {})) {
    if (typeof value !== "boolean") return refuse("funnel_state_ambiguous");
    if (!/^.+:[0-9]+$/.test(key) && key !== "8443") return refuse("funnel_state_ambiguous");
    if (key.split(":").pop() === "8443" && value) return refuse("funnel_exposed");
  }
  if (Object.keys(document.TCP || {}).some((key) => !/^[0-9]+$/.test(key) || !portNumber(Number(key)))) return refuse("serve_state_ambiguous");
  const tcp = (document.TCP || {})["8443"];
  const entries = Object.entries(document.Web || {}).filter(([key]) => key.split(":").pop() === "8443");
  const agentUrl = `https://${dns}:8443/v1/chat/completions`;
  if (tcp === undefined && entries.length === 0) return {
    status: "proposal", reason: "route_absent", agentUrl,
    command: `${tailscaleCommandPrefix(context.cliArgv)} serve --bg --https=8443 http://127.0.0.1:${context.relayPort}`,
  };
  if (!record(tcp) || tcp.HTTPS !== true || Object.keys(tcp).some((key) => key !== "HTTPS") || entries.length !== 1) return refuse("route_shape_conflict");
  const [host, value]      = entries[0];
  if (normalizeDnsName(host.slice(0, -5)) !== dns) return refuse("route_identity_conflict");
  if (!record(value) || Object.keys(value).some((key) => key !== "Handlers") || !record(value.Handlers) || Object.keys(value.Handlers).length !== 1) return refuse("route_handler_conflict");
  const root = value.Handlers["/"];
  if (!record(root) || Object.keys(root).length !== 1 || root.Proxy !== `http://127.0.0.1:${context.relayPort}`) {

    const owner = record(root) && Object.keys(root).length === 1 ? phoneRouteRuntime(document, dns, root.Proxy, context.runtime) : null;
    return owner ? { ...refuse("foreign_route"), owner } : refuse("foreign_route");
  }
  return { status: "ready", reason: "route_matches", command: null, agentUrl };
}

function probeEvenAiActivation(port     , token     ) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status     ) => { if (!settled) { settled = true; resolve(status); } };
    const req = http.request({ hostname: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, timeout: 2500 }, (res     ) => {
      let body = "";
      res.on("data", (chunk     ) => { body += chunk; if (body.length > 8192) { finish("unknown"); req.destroy(); } });
      res.on("error", () => finish("unknown"));
      res.on("end", () => {
        try {
          const content = JSON.parse(body)?.choices?.[0]?.message?.content;
          finish(res.statusCode === 200 && content === "The last user message must be plain text." ? "active" : "pending");
        } catch (_) { finish(res.statusCode === 404 ? "pending" : "unknown"); }
      });
    });
    req.on("timeout", () => { finish("unknown"); req.destroy(); });
    req.on("error", () => finish("unknown"));
    req.end('{"messages":[]}');
  });
}

function createEvenAiSetupCommand(api     , controller     , deps      = {}) {
  const configApi = api?.runtime?.config;
  const probe = deps.probeActivation || probeEvenAiActivation;
  const readHost = deps.readHostContext || ((journey     ) => readEvenAiHostContext(journey, deps));
  return async function evenAiSetup(action     ) {
    const failed = (reason     ) => ({ exitCode: 1, report: {
      capability: "even-ai", status: "unavailable", reason, requestVerification: "not-verified",
      action: reason === "private_token_required" ? "Run openclaw ocuclaw credential even-ai in this host's private terminal, then enable."
        : reason === "tailscale_receipt_unreadable" ? "Check this host's Tailscale installation and Cloudways status if applicable. Preserve existing routes; do not substitute a guessed binary or socket."
        : reason === "saved_and_live_port_differ" ? "The saved port differs from the running relay. Let activation finish and reconnect, then re-read status before proposing a route."
        : "Re-read status on the selected Primary Runtime. If its observations or supported config interface remain unavailable, use that Runtime Bundle's Setup Assistant. Preserve existing credentials and routes.",
    } });
    if (!["status", "enable", "route", "verify"].includes(action)) return failed("unsupported_action");
    if (typeof configApi?.current !== "function") return failed("config_observation_unavailable");
    try {
      const observedHostConfig = configApi.current();
      const activationPlan = planOptionalSetupActivation(observedHostConfig, api?.runtime?.version);
      const observedConfig = pluginConfig(observedHostConfig);
      if (!validConfig(observedConfig)) return failed("plugin_config_unavailable");
      let config = { ...observedConfig };
      if (action === "enable") {
        if (!tokenPresent(config)) return failed("private_token_required");
        if (config.evenAiEnabled !== true) {
          if (typeof configApi.mutateConfigFile !== "function") return failed("activation_unsupported");
          const expectedToken = config.evenAiToken;
          const mutation = await configApi.mutateConfigFile({ afterWrite: activationPlan.afterWrite, mutate(draft     ) {
            if (JSON.stringify(planOptionalSetupActivation(draft, api?.runtime?.version)) !== JSON.stringify(activationPlan)) throw new Error("activation_policy_changed");
            const target = pluginConfig(draft);
            if (!validConfig(target) || target.evenAiToken !== expectedToken || effectiveRelayPort(target) !== effectiveRelayPort(config)) throw new Error("context_changed");
            target.evenAiEnabled = true;
          } });
          const saved = pluginConfig(mutation?.nextConfig);
          if (!validConfig(saved) || saved.evenAiEnabled !== true || saved.evenAiToken !== expectedToken) return failed("save_not_observed");
          config = { ...saved };
        }
      }
      const report      = { capability: "even-ai", runtime: "openclaw", token: tokenPresent(config) ? "present" : "absent",
        activationPolicy: activationPlan.policy, activationPolicyReason: activationPlan.reason,
        saved: tokenPresent(config), enabled: config.evenAiEnabled === true, activation: "unknown", requestVerification: "not-verified",
        action: "Use the terminal of the Primary Runtime selected in OcuClaw. Run openclaw ocuclaw credential even-ai for private entry; blank input preserves the existing token." };

      const customAgentUrl = customEvenAiAgentUrl(config.phoneAddress);
      if (typeof config.phoneAddress === "string" && config.phoneAddress.trim()) {
        report.phoneRoute = "custom";
        report.note = customAgentUrl ? EVEN_AI_CUSTOM_ROUTE_NOTE
          : canonicalizeRelayAddressV1(config.phoneAddress.trim()).ok ? EVEN_AI_TAILSCALE_ROUTE_NOTE : EVEN_AI_INVALID_ADDRESS_NOTE;
        if (customAgentUrl) report.agentUrl = customAgentUrl;
      }
      const journey = await controller("journey", { surface: "cli" });
      const installationId = journey?.installation?.id;
      const live = journey?.currentHealth;
      const port = live?.privateRoute?.relay?.port;
      if (!journey?.installation?.id || live?.relay !== "running" || !portNumber(port) || live.privateRoute.relay.status !== "running") {
        return { exitCode: 1, report: { ...report, status: report.saved ? "saved" : "not-configured", reason: "live_bound_port_unavailable", action: "Reconnect to the owning OpenClaw runtime, then run openclaw ocuclaw even-ai status. No route was proposed." } };
      }
      if (effectiveRelayPort(config) !== port) return failed("saved_and_live_port_differ");
      report.activation = report.saved && report.enabled ? await probe(port, config.evenAiToken) : "pending";
      const unchangedConfig = () => {
        const current = pluginConfig(configApi.current());
        return current?.evenAiToken === config.evenAiToken && current?.evenAiEnabled === config.evenAiEnabled && effectiveRelayPort(current) === effectiveRelayPort(config);
      };
      if (!unchangedConfig()) return failed("configuration_changed");
      report.status = report.activation === "active" ? "active" : report.saved ? "saved" : "not-configured";
      if (report.saved) report.action = report.activation === "active"
        ? "The endpoint accepts the current token. Run openclaw ocuclaw even-ai route next. An active endpoint is not a verified glasses request."
        : !report.enabled ? "The token is saved. Run openclaw ocuclaw even-ai enable on this selected OpenClaw host."
        : `${activationPlan.action} Run openclaw ocuclaw even-ai status. Do not rotate the token.`;
      if (action === "status" || action === "enable") return { exitCode: 0, report };
      if (customAgentUrl) {

        const active = report.activation === "active";
        if (active) report.status = "available-to-test";
        report.action = active
          ? "Even AI uses your phone address. Configure the Even app with agentUrl and your private token, select that agent, then make a real Even AI glasses request. This observation does not verify that request."
          : "Even AI uses your phone address once it is active. Finish private entry and enable, then re-run status after reconnecting. Preserve the token and phone route.";
        return { exitCode: action === "verify" && !active ? 1 : 0, report };
      }
      const host = await readHost(journey);
      if (!host || !validCli(host.cliArgv)) return failed("tailscale_receipt_unreadable");
      const originalHost = JSON.stringify(host);
      const run = (args     ) => (deps.runTailscale || defaultRunTailscale)(args, host.cliArgv);
      const [serve, node]      = await Promise.all([readServeStatus(run), readNodeState(run)]);
      const latest = await controller("journey", { surface: "cli" });
      const latestHost = await readHost(latest);
      if (!unchangedConfig() || latest?.installation?.id !== installationId || latest?.currentHealth?.relay !== "running" || latest?.currentHealth?.privateRoute?.relay?.port !== port || JSON.stringify(latestHost) !== originalHost) return failed("host_context_changed");
      report.route = planEvenAiRoute(serve.document, { ...node, ...host, runtime: "openclaw", relayPort: port });
      report.status = report.route.status === "ready" && report.activation === "active" ? "available-to-test" : report.status;
      report.action = report.route.status === "proposal"
        ? "Optional, tailnet only: re-run route immediately before pasting its command in this terminal. It leaves the phone route untouched. After applying it yourself, run openclaw ocuclaw even-ai verify."
        : report.route.status === "ready" ? report.activation === "active"
          ? "Route shape is ready. Configure the Even app with agentUrl and your private token, select that agent, then make a real Even AI glasses request. This observation does not verify that request."
          : "Route shape is ready but activation is not confirmed. Finish private entry and enable, then re-run status after reconnecting. Preserve the token and phone route."
        : "Resolve the route conflict or unknown host observation; do not replace another service or enable Funnel.";
      return { exitCode: report.route.status === "refused" || (action === "verify" && report.route.status !== "ready") ? 1 : 0, report };
    } catch (_) { return failed("observation_or_save_failed"); }
  };
}

module.exports = { EVEN_AI_CUSTOM_ROUTE_NOTE, EVEN_AI_TAILSCALE_ROUTE_NOTE, EVEN_AI_INVALID_ADDRESS_NOTE, customEvenAiAgentUrl, resolveEvenAiLocalCli, readEvenAiHostContext, evenAiHostCliProblem, planEvenAiRoute, probeEvenAiActivation, createEvenAiSetupCommand };
