const { randomBytes } = require("node:crypto");
const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { evaluateCustomRoute } = require("../domain/custom-route/custom-route-check.cjs");
const { ROUTE_PROBE_NONCE_PARAM, ROUTE_PROBE_PATH, routeProbeAnswerMatches } = require("../domain/custom-route/route-probe.cjs");
const { defaultProbeLoopbackTarget } = require("./private-route.cjs");

const CUSTOM_STATUS_HEALTHY = "healthy";
const CUSTOM_STATUS_UNVERIFIED = "unverified";
const CUSTOM_STATUS_WRONG = "wrong";

const CUSTOM_REASON_NO_RELAY_PORT = "relay-port-unknown";

const PROBE_TIMEOUT_MS = 2500;
const PROBE_MAX_BODY_BYTES = 1024;

function isRecord(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedPort(value     ) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function configuredPhoneAddress(api     ) {
  const pick = (config     ) => {
    const value = config?.plugins?.entries?.ocuclaw?.config?.phoneAddress;
    return typeof value === "string" && value.trim() ? value : null;
  };
  try {
    const configApi = api?.runtime?.config;
    if (configApi && typeof configApi.current === "function") {
      const live = configApi.current();
      if (isRecord(live)) return pick(live);
    }
  } catch (_) {  }
  const boot = api?.pluginConfig?.phoneAddress;
  return typeof boot === "string" && boot.trim() ? boot : null;
}

function authorityOf(address        ) {
  const authority = address.slice("wss://".length);
  const colon = authority.lastIndexOf(":");
  return { hostname: authority.slice(0, colon), port: Number(authority.slice(colon + 1)) };
}

function defaultResolveHost(hostname        ) {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (error     , records     ) => {
      if (error || !Array.isArray(records) || records.length === 0) { resolve({ ok: false }); return; }
      resolve({ ok: true, addresses: records.map((record     ) => record.address) });
    });
  });
}

function defaultProbeFrontDoor(ip        , hostname        , port        , nonce        ) {
  return new Promise((resolve) => {
    let settled = false;
    let request      = null;
    let connected = false;
    let handshook = false;
    const settle = (value     ) => { if (settled) return; settled = true; clearTimeout(timer); try { request?.destroy(); } catch (_) {  } resolve(value); };
    const failed = () => ({ tcp: handshook ? "ok" : "fail", tls: "ok", status: null, mac: null });
    const timer = setTimeout(() => settle(failed()), PROBE_TIMEOUT_MS);
    const literal = net.isIP(hostname) !== 0;
    try {
      request = https.request({
        host: ip, port, method: "GET", agent: false,
        path: `${ROUTE_PROBE_PATH}?${ROUTE_PROBE_NONCE_PARAM}=${encodeURIComponent(nonce)}`,
        headers: { host: `${hostname}:${port}` },
        rejectUnauthorized: true,
        ...(literal ? {} : { servername: hostname }),
        checkServerIdentity: (_host     , cert     ) => tls.checkServerIdentity(hostname, cert),
      }, (response     ) => {
        handshook = true;
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk     ) => {
          body += chunk;
          if (body.length > PROBE_MAX_BODY_BYTES) settle({ tcp: "ok", tls: "ok", status: response.statusCode, mac: null });
        });
        response.once("end", () => {
          let mac = null;
          try { const parsed = JSON.parse(body); if (isRecord(parsed) && typeof parsed.mac === "string") mac = parsed.mac; } catch (_) {  }
          settle({ tcp: "ok", tls: "ok", status: response.statusCode, mac });
        });
        response.once("error", () => settle(failed()));
      });
      request.once("socket", (socket     ) => {
        socket.once("connect", () => { connected = true; });
        socket.once("secureConnect", () => { handshook = true; });
      });
      request.once("error", (error     ) => {
        const code = typeof error?.code === "string" ? error.code : "";

        const certificate = connected && !handshook &&
          /CERT|SELF_SIGNED|UNABLE_TO_|HOSTNAME|ALTNAME|ERR_TLS_CERT/i.test(code);
        settle(certificate ? { tcp: "ok", tls: "cert_rejected", status: null, mac: null } : failed());
      });
      request.end();
    } catch (_) {
      settle(failed());
    }
  });
}

function probeVerdict(door     , relayCredential     , nonce        ) {
  if (!door || door.tcp !== "ok" || door.tls !== "ok") return "no_answer";
  if (door.status === 429) return "rate_limited";
  if (door.status === null || door.status === undefined) return "no_answer";
  if (door.status !== 200 || typeof door.mac !== "string") return "not_relay";

  const candidates = (Array.isArray(relayCredential) ? relayCredential : [relayCredential])
    .filter((value     ) => typeof value === "string" && value);
  if (candidates.length === 0) return "no_answer";
  return candidates.some((value        ) => routeProbeAnswerMatches(value, nonce, door.mac)) ? "match" : "mismatch";
}

function createCustomRouteReader(deps      = {}) {
  const probeLoopback = typeof deps.probeLoopbackTarget === "function" ? deps.probeLoopbackTarget : defaultProbeLoopbackTarget;
  const resolveHost = typeof deps.resolveHost === "function" ? deps.resolveHost : defaultResolveHost;
  const probeFrontDoor = typeof deps.probeFrontDoor === "function" ? deps.probeFrontDoor : defaultProbeFrontDoor;
  const nonceOf = typeof deps.nonce === "function" ? deps.nonce : () => randomBytes(32).toString("base64url");
  const clock = typeof deps.now === "function" ? deps.now : () => new Date().toISOString();

  return async function readCustomRoute(relayPort     , context      = {}) {

    const observations      = {
      address: context.phoneAddress,
      cloudways: !!context.host && context.host.managed === "cloudways",
      loopbackRelay: "ok",
      resolve: { ok: true, addresses: [] },
      tcp: "ok",
      tls: "ok",
      probe: "match",
    };
    const reachability      = { target: "not-probed", frontDoor: "not-probed" };
    let noRelayPort = false;
    const pending = () => evaluateCustomRoute(observations);
    const run = async () => {
      const gate = pending();
      if (gate.check === "address" || gate.check === "cloudways") return;
      if (!boundedPort(relayPort)) { noRelayPort = true; observations.loopbackRelay = "fail"; return; }
      reachability.target = await probeLoopback(relayPort);
      if (reachability.target !== "listening") { observations.loopbackRelay = "fail"; return; }
      const { hostname, port } = authorityOf(gate.address          );
      observations.resolve = net.isIP(hostname) === 4 ? { ok: true, addresses: [hostname] } : await resolveHost(hostname);
      const after = pending();
      if (after.check === "dns" || after.check === "private") return;

      const ip = observations.resolve.addresses[0];
      const nonce = nonceOf();
      const door      = await probeFrontDoor(ip, hostname, port, nonce);
      reachability.frontDoor = door?.tcp !== "ok" ? "unreachable" : door.tls !== "ok" ? "tls-handshake-failed" : "accepted";
      observations.tcp = door?.tcp === "ok" ? "ok" : "fail";
      observations.tls = door?.tls === "cert_rejected" ? "cert_rejected" : "ok";
      observations.probe = probeVerdict(door, context.relayCredential, nonce);
    };
    await run();
    const verdict = evaluateCustomRoute(observations);
    const reason = noRelayPort ? CUSTOM_REASON_NO_RELAY_PORT : verdict.reason;
    const status = verdict.verdict === "ready" ? CUSTOM_STATUS_HEALTHY
      : verdict.verdict === "unverified" ? CUSTOM_STATUS_UNVERIFIED : CUSTOM_STATUS_WRONG;
    if (verdict.verdict !== "wrong" && verdict.address && typeof context.onVerifiedAddress === "function") {
      context.onVerifiedAddress(verdict.address);
    }
    return {
      schemaVersion: 1,
      mode: "custom",
      status,
      evidence: reason ?? "custom-route-ready",
      observedAt: clock(),
      relay: { status: "running", port: boundedPort(relayPort) ? relayPort : null, evidence: "relay-instance-check" },
      customRoute: { answer: verdict.verdict, check: verdict.check, reason },
      reachability,

      ownership: { status: "not-applicable", basis: null, receipt: "custom-route-writes-no-receipt", evidence: "configured-phone-address" },
      proposal: { status: "not-needed", applyCommand: null, reason: "custom-route" },
      teardown: { status: "not-applicable", command: null, reason: "custom-route" },
      phoneAddress: {
        status: verdict.verdict === "ready" ? "verified" : verdict.verdict === "unverified" ? "unverified" : "unavailable",
        scheme: "wss",
        host: "configured-phone-address",
        hostSource: "plugins.entries.ocuclaw.config.phoneAddress",
        reason: reason ?? "custom-route-ready",
      },
      receiptPolicy: "observation-evidence-only-never-a-host-or-network-mutation",
    };
  };
}

module.exports = { CUSTOM_STATUS_HEALTHY, CUSTOM_STATUS_UNVERIFIED, CUSTOM_STATUS_WRONG, CUSTOM_REASON_NO_RELAY_PORT, configuredPhoneAddress, defaultResolveHost, defaultProbeFrontDoor, createCustomRouteReader };
