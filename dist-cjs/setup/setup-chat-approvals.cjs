const { APPLY_ROUTE_OPERATION, CONFIRM_PAIRING_OPERATION, PAIR_WITH_PHONE_CODE_OPERATION, SETUP_CHAT_ANSWERS, SETUP_CHAT_OPERATIONS, consumeApproval, heldPairingExchange, holdPairingExchange, lookupApproval, notePairingState, noteSetupReceipt, pairingShownText, promptWords, releasePairingExchange, setupChatReceipt } = require("./setup-approval-store.cjs");
const { awaitRouteCertificate, CERTIFICATE_WAIT_HEALTHY, CERTIFICATE_WAIT_REFUSED, defaultReadRoute, defaultRelayPort, serveApplyArgv } = require("./cloudways-setup.cjs");
const { defaultRunCommand } = require("./cloudways.cjs");
const { CERT_DOMAINS_UNAVAILABLE, CERT_DOMAINS_UNKNOWN, CLASSIFY_ABSENT, CLASSIFY_READY, CLASSIFY_WRONG, ROUTE_STATUS_CONFLICTING, ROUTE_STATUS_EXPOSED, ROUTE_STATUS_FOREIGN, ROUTE_STATUS_HEALTHY, defaultRunTailscale, readCertDomains, readNodeState, readTailscaleCliReceipt, resolveHostStateDir } = require("./private-route.cjs");
const { startCertificateIssuance } = require("./certificate-issuance.cjs");
const { pairingControlRequest } = require("./pairing-terminal.cjs");
const { pairingPreflight } = require("./pairing-command.cjs");
const { normalizePhoneCode } = require("../domain/pairing/pairing-note.cjs");
const { resolveSetupStateDir } = require("./setup-controller.cjs");
const process = require("node:process");

const ROUTE_APPLY_TIMEOUT_MS = 30000;
const PAIRING_POLL_MS = 1000;
const PAIRING_CODE_WAIT_MS = 45000;
const PAIRING_CONFIRM_WAIT_MS = 60000;
const DETAIL_MAX_CHARS = 160;

const CHAT_PARAMS                                              = Object.freeze({
  [APPLY_ROUTE_OPERATION]: Object.freeze(["operation", "binding", "answer"]),
  [CONFIRM_PAIRING_OPERATION]: Object.freeze(["operation", "binding", "answer"]),
  [PAIR_WITH_PHONE_CODE_OPERATION]: Object.freeze(["operation", "code"]),
});

function invalidInput(message        ) {
  const err      = new Error(`invalid_input: ${message}`);
  err.code = "invalid_input";
  return err;
}

function validateSetupChatParams(params     ) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw invalidInput("params must be an object");
  const allowed = CHAT_PARAMS[params.operation];
  if (!allowed) throw invalidInput(`operation must be one of ${SETUP_CHAT_OPERATIONS.join(", ")}`);
  const extra = Object.keys(params).find((key) => !allowed.includes(key));
  if (extra) throw invalidInput(`${params.operation} does not take ${extra}`);
  if (params.answer !== undefined && !(SETUP_CHAT_ANSWERS                     ).includes(params.answer)) {
    throw invalidInput("answer must be yes or no");
  }
  return params;
}

function validPort(port     ) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function chatRouteTailscaleArgv(hostStateDir      = null)                  {
  try {
    const dir = typeof hostStateDir === "string" && hostStateDir ? hostStateDir : resolveHostStateDir(process.env);
    const receipt      = readTailscaleCliReceipt(dir);
    return receipt && Array.isArray(receipt.argv) ? receipt.argv.slice() : null;
  } catch (_) {
    return null;
  }
}

function chatRouteCommand(relayPort     , servePortValue      = null, tailscaleArgv      = undefined)         {
  const argv = tailscaleArgv === undefined ? chatRouteTailscaleArgv() : tailscaleArgv;
  return serveApplyArgv(relayPort, servePortValue, argv).join(" ");
}

function chatRouteVerdict(route     )         {
  if (!route || typeof route !== "object") return "unreadable";
  const classification = route.route && route.route.classification;
  if (route.status === ROUTE_STATUS_HEALTHY || classification === CLASSIFY_READY) return "already";
  if (route.status === ROUTE_STATUS_CONFLICTING || route.status === ROUTE_STATUS_FOREIGN
    || route.status === ROUTE_STATUS_EXPOSED || classification === CLASSIFY_WRONG) return "foreign";
  if (classification === CLASSIFY_ABSENT) {
    return route.proposal && route.proposal.status === "presented" ? "apply" : "unreadable";
  }
  return "unreadable";
}

function applyFailureDetail(applied     ) {
  const text = applied && (applied.stderr || applied.stdout) ? String(applied.stderr || applied.stdout) : "";
  const line = text.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (line) return line.length > DETAIL_MAX_CHARS ? `${line.slice(0, DETAIL_MAX_CHARS - 3)}...` : line;
  return applied && Number.isInteger(applied.code) ? `exit ${applied.code}` : "no output";
}

function defaultStartCertificate(tailscaleArgv           ) {
  return async function startCertificate(budgetMs     ) {
    const argv = tailscaleArgv();
    const node      = await readNodeState((args     ) => defaultRunTailscale(args, argv));
    if (!node || !node.dnsName) return null;
    return startCertificateIssuance(argv, node.dnsName, budgetMs);
  };
}

function defaultReadHttps(tailscaleArgv           ) {
  return function readHttps() {
    const argv = tailscaleArgv();
    return readCertDomains((args     ) => defaultRunTailscale(args, argv));
  };
}

function resolveDeps(api     , controller     , deps     ) {
  const pick = (name        , fallback     ) => (typeof deps[name] === "function" ? deps[name] : fallback);
  const servePortValue = deps.servePort === undefined ? null : deps.servePort;
  const tailscaleArgv = pick("tailscaleArgv", () => chatRouteTailscaleArgv());
  return {
    stateDir: pick("stateDir", () => resolveSetupStateDir(api)),
    servePort: servePortValue,
    tailscaleArgv,
    relayPort: pick("relayPort", defaultRelayPort(api, controller)),

    readRoute: pick("readRoute", (relayPort     ) => defaultReadRoute(api, { servePort: servePortValue })(relayPort)),
    readHttps: pick("readHttps", defaultReadHttps(tailscaleArgv)),
    runServeApply: pick("runServeApply", (argv     ) => defaultRunCommand(argv, { timeoutMs: ROUTE_APPLY_TIMEOUT_MS })),
    startCertificate: pick("startCertificate", defaultStartCertificate(tailscaleArgv)),
    preflight: pick("preflight", () => pairingPreflight(api, controller,
      typeof deps.adoptedRelayCredential === "function" ? { adoptedRelayCredential: deps.adoptedRelayCredential } : {}, "tool")),
    request: pick("request", pairingControlRequest),
    now: pick("now", () => Date.now()),
    sleep: pick("sleep", (ms     ) => new Promise((resolve     ) => setTimeout(resolve, ms))),
    pollMs: Number(deps.pollMs) > 0 ? Number(deps.pollMs) : undefined,
    certificateWaitMs: Number(deps.certificateWaitMs) > 0 ? Number(deps.certificateWaitMs) : undefined,
    pairingPollMs: Number(deps.pairingPollMs) > 0 ? Number(deps.pairingPollMs) : PAIRING_POLL_MS,
    pairingCodeWaitMs: Number(deps.pairingCodeWaitMs) > 0 ? Number(deps.pairingCodeWaitMs) : PAIRING_CODE_WAIT_MS,
    pairingConfirmWaitMs: Number(deps.pairingConfirmWaitMs) > 0 ? Number(deps.pairingConfirmWaitMs) : PAIRING_CONFIRM_WAIT_MS,
  };
}

async function applyRoute(params     , d     ) {
  const receipt = (status        , detail         ) => setupChatReceipt(APPLY_ROUTE_OPERATION, status, detail);
  const stateDir = d.stateDir();
  const entry = lookupApproval(stateDir, params.binding);
  if (!entry || entry.operation !== APPLY_ROUTE_OPERATION) return receipt("stale_binding");
  let relayPort     ;
  try { relayPort = await d.relayPort(); } catch (_) { relayPort = null; }
  if (!validPort(relayPort)) return receipt("unreadable");

  const argv = serveApplyArgv(relayPort, d.servePort, d.tailscaleArgv());
  if (argv.join(" ") !== entry.shown) return receipt("stale_binding");
  if (!consumeApproval(stateDir, params.binding, APPLY_ROUTE_OPERATION)) return receipt("stale_binding");

  let route      = null;
  try { route = await d.readRoute(relayPort); } catch (_) { route = null; }
  const verdict = chatRouteVerdict(route);
  if (verdict !== "apply") return receipt(verdict);

  let https      = CERT_DOMAINS_UNKNOWN;
  try { https = await d.readHttps(); } catch (_) { https = CERT_DOMAINS_UNKNOWN; }
  if (https === CERT_DOMAINS_UNAVAILABLE) return receipt("https_off");
  let applied      = null;
  try { applied = await d.runServeApply(argv); } catch (_) { applied = null; }
  if (!applied || applied.code !== 0) return receipt("failed", applyFailureDetail(applied));
  const waited = await awaitRouteCertificate({
    relayPort, route, readRoute: d.readRoute, startCertificate: d.startCertificate,
    now: d.now, sleep: d.sleep, pollMs: d.pollMs, certificateWaitMs: d.certificateWaitMs,
  });
  if (waited.outcome === CERTIFICATE_WAIT_HEALTHY) return receipt("applied");
  if (waited.outcome === CERTIFICATE_WAIT_REFUSED) return receipt("certificate_refused");
  return receipt("certificate_timeout");
}

function controlTimeoutMs(op        ) {
  return op === "create" ? 12000 : op === "phone-code-status" ? 4000 : 3000;
}

async function cancelHeld(stateDir     ) {
  const held = heldPairingExchange(stateDir);
  if (!held) return;
  try { await held.call("cancel"); } catch (_) {  }
  releasePairingExchange(stateDir, "none");
}

async function pairWithPhoneCode(params     , d     , signal     ) {
  const receipt = (status        , detail      = undefined) => setupChatReceipt(PAIR_WITH_PHONE_CODE_OPERATION, status, detail);
  const stateDir = d.stateDir();
  let checked     ;
  try { checked = await d.preflight(); } catch (_) { checked = null; }

  if (!checked || checked.ok !== true) {
    return receipt("not_ready", checked && typeof checked.code === "string" ? checked.code : "preflight_error");
  }
  const normalized      = normalizePhoneCode(params.code);
  if (normalized.kind === "invalid") return receipt("malformed");
  if (normalized.kind === "pairing-code") return receipt("pairing_code_typed");
  const customRoute = checked.customAddress !== null && checked.customAddress !== undefined;

  const connection      = {
    port: checked.port,
    relayCredential: checked.credential,
    phoneAddress: checked.phoneAddress,
    installationId: checked.journey && checked.journey.installation ? checked.journey.installation.id : "",
    ...(customRoute ? { customRoute: true } : {}),
  };
  checked.credential = undefined;

  await cancelHeld(stateDir);
  const call = (op        , extra      = {}, secret = "") =>
    d.request(connection, { op, ...extra }, secret, controlTimeoutMs(op));
  let status     ;
  try { status = await call("phone-code-status", { address: connection.phoneAddress, customRoute }); }
  catch (_) { status = { available: false }; }

  if (!status || status.available !== true) return receipt("phone_codes_unavailable");
  let created     ;
  try {
    created = await call("create", {
      address: connection.phoneAddress,
      ...(customRoute ? { customRoute: true } : {}),
      phoneCode: normalized.code,
    });
  } catch (error     ) {
    return receipt(error && error.reason === "busy" ? "busy" : "failed");
  }
  if (created && typeof created.reason === "string" && created.reason) {
    if (created.reason === "no_code" || created.reason === "spent") return receipt("no_code");
    if (created.reason === "malformed") return receipt("malformed");
    if (created.reason === "pairing_code_typed") return receipt("pairing_code_typed");
    return receipt("failed");
  }
  if (!created || typeof created.controlSecret !== "string" || !created.controlSecret
    || typeof created.exchangeId !== "string" || !created.exchangeId) return receipt("failed");
  const exchangeId         = created.exchangeId;
  const secret         = created.controlSecret;
  const exchangeCall = (op        ) => d.request(connection, { op }, secret, controlTimeoutMs(op));
  if (created.delivery !== "sent") {

    try { await exchangeCall("cancel"); } catch (_) {  }
    return receipt("phone_codes_unavailable");
  }
  holdPairingExchange(stateDir, { exchangeId, call: exchangeCall });
  const deadline = d.now() + d.pairingCodeWaitMs;
  for (;;) {
    const held = heldPairingExchange(stateDir);
    if (!held || held.exchangeId !== exchangeId) return receipt("failed");
    let exchange     ;
    try { exchange = await exchangeCall("state"); }
    catch (_) {
      releasePairingExchange(stateDir, "failed");
      return receipt("failed");
    }
    const state = notePairingState(stateDir, exchange);
    if (state === "words_ready") {
      if (promptWords(exchange, exchangeId)) return receipt("words_ready");

      await cancelHeld(stateDir);
      releasePairingExchange(stateDir, "failed");
      return receipt("failed");
    }
    if (state !== "waiting_for_phone") return receipt("failed");
    if (d.now() >= deadline || (signal && signal.aborted)) return receipt("sent");
    await d.sleep(Math.max(0, Math.min(d.pairingPollMs, deadline - d.now())));
  }
}

async function confirmPairing(params     , d     ) {
  const receipt = (status        ) => setupChatReceipt(CONFIRM_PAIRING_OPERATION, status);
  const stateDir = d.stateDir();
  const entry = lookupApproval(stateDir, params.binding);
  if (!entry || entry.operation !== CONFIRM_PAIRING_OPERATION) return receipt("stale_binding");
  const held = heldPairingExchange(stateDir);
  if (!held || held.exchangeId !== entry.exchangeId) return receipt("stale_binding");

  let exchange     ;
  try { exchange = await held.call("state"); }
  catch (_) {
    releasePairingExchange(stateDir, "failed");
    return receipt("failed");
  }
  const before = notePairingState(stateDir, exchange);
  if (before === "expired") return receipt("expired");
  const words = before === "words_ready" ? promptWords(exchange, held.exchangeId) : null;
  if (!words || pairingShownText(words) !== entry.shown) return receipt("stale_binding");
  if (!consumeApproval(stateDir, params.binding, CONFIRM_PAIRING_OPERATION)) return receipt("stale_binding");
  let response     ;
  try { response = await held.call("approve"); }
  catch (_) {
    releasePairingExchange(stateDir, "failed");
    return receipt("failed");
  }
  if (!response || response.ok !== true) {
    if (response && response.state === "failed" && response.failure && response.failure.reason === "expired") {
      releasePairingExchange(stateDir, "expired");
      return receipt("expired");
    }

    try { await held.call("cancel"); } catch (_) {  }
    releasePairingExchange(stateDir, "failed");
    return receipt("failed");
  }
  if (response.state === "completed") {
    const delivered = response.credentialExposure === "delivered";
    releasePairingExchange(stateDir, delivered ? "completed" : "failed");
    return receipt(delivered ? "paired" : "failed");
  }
  const after = notePairingState(stateDir, response);
  if (after === "expired") return receipt("expired");
  if (after === "failed") return receipt("failed");
  const deadline = d.now() + d.pairingConfirmWaitMs;
  for (;;) {
    if (d.now() >= deadline) return receipt("approved_waiting");
    await d.sleep(Math.max(0, Math.min(d.pairingPollMs, deadline - d.now())));
    if (heldPairingExchange(stateDir) !== held) return receipt("approved_waiting");
    let polled     ;
    try { polled = await held.call("state"); }
    catch (_) {

      releasePairingExchange(stateDir, "approved");
      return receipt("approved_waiting");
    }
    if (polled && polled.state === "completed") {
      const delivered = polled.credentialExposure === "delivered";
      releasePairingExchange(stateDir, delivered ? "completed" : "failed");
      return receipt(delivered ? "paired" : "failed");
    }
    const state = notePairingState(stateDir, polled);
    if (state === "expired") return receipt("expired");
    if (state === "failed") return receipt("failed");
  }
}

function createSetupChatApprovals(api     , controller     , deps      = {}) {
  const d = resolveDeps(api, controller, deps && typeof deps === "object" ? deps : {});
  return async function runSetupChatOperation(params     , signal      = null) {
    validateSetupChatParams(params);
    const receipt = params.operation === APPLY_ROUTE_OPERATION ? await applyRoute(params, d)
      : params.operation === CONFIRM_PAIRING_OPERATION ? await confirmPairing(params, d)
        : await pairWithPhoneCode(params, d, signal);

    try { noteSetupReceipt(d.stateDir(), receipt); } catch (_) {  }
    return receipt;
  };
}

module.exports = { validateSetupChatParams, chatRouteTailscaleArgv, chatRouteCommand, chatRouteVerdict, createSetupChatApprovals };
