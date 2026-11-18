const { decideNext, SETUP_SAY, SETUP_STUCK_SAY } = require("./setup-decide.cjs");
const { SETUP_NEXT_OPERATION, validateNextResult } = require("./setup-next-contract.cjs");
const { APPLY_ROUTE_OPERATION, CONFIRM_PAIRING_OPERATION, PAIR_WITH_PHONE_CODE_OPERATION, lastSetupReceipt, pairingStatus, pendingPairing, pendingRouteApproval } = require("./setup-approval-store.cjs");
const { chatRouteCommand, chatRouteTailscaleArgv } = require("./setup-chat-approvals.cjs");
const { awaitRouteCertificate, CERTIFICATE_WAIT_REFUSED, defaultGrantConversationAccess, defaultReadRoute } = require("./cloudways-setup.cjs");
const { binariesPresent, enroll: cloudwaysEnroll, install: cloudwaysInstall, resolveLayout, startDaemon } = require("./cloudways.cjs");
const { CERT_DOMAINS_AVAILABLE, CERT_DOMAINS_UNAVAILABLE, defaultRunTailscale, readCertDomains, readNodeState, readPhonePresence, readTailscaleCliReceipt, resolveHostStateDir } = require("./private-route.cjs");
const { startCertificateIssuance, queryHttpsEnableLink } = require("./certificate-issuance.cjs");
const { conversationAccessGranted } = require("./conversation-access.cjs");
const { resolveSetupStateDir } = require("./setup-controller.cjs");
const { JEV_CHECK_FILE, readJevCheckRecord } = require("./jev-key-check.cjs");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const SETUP_NEXT_ANSWERS_FILENAME = "ocuclaw.setup-next.json";
const SETUP_NEXT_ANSWERS_SCHEMA = 1;

const SETUP_NEXT_ANSWER_KEYS = Object.freeze({
  host: Object.freeze(["cloudways", "other"]),
  tailscale: Object.freeze(["system", "plugin"]),

  extras: Object.freeze(["voice", "even_ai", "jev", "bug_reports", "card_tools", "none"]),

  phone: Object.freeze(["skip"]),
});

const SETUP_NEXT_MOMENT_KEYS = Object.freeze(["setupBegunAt"]);
const SETUP_NEXT_CHOICE_MAX = 64;

const NEXT_CERTIFICATE_WAIT_MS = 45000;
const NEXT_FIRST_USE_WAIT_MS = 30000;
const NEXT_PAIRING_WAIT_MS = 20000;
const NEXT_POLL_MS = 1000;

const MAX_DECISIONS = 8;

const RUN_STEP                                   = Object.freeze({
  grant_access: "plugin_access",
  start_tailscale: "private_network",
  enroll: "approve_machine",
  issue_certificate: "private_route",
  arm_first_use: "first_message",
});

function isRecord(value     ) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stuckReport(step        , code        , checked           = [], tried           = [], detail      = null) {
  const line = SETUP_STUCK_SAY[code];
  const say = line ? [line] : [];
  if (typeof detail === "string" && detail.trim()) say.push(`Details: ${detail.trim()}`);
  return { step, code, ...(say.length ? { say } : {}), checked, tried };
}

function setupNextProfile(journey     , answers      = {}) {
  const host = isRecord(journey?.host) ? journey.host : {};
  const environment = isRecord(journey?.environment) ? journey.environment : {};
  const verdict = host.detectVerdict;
  const answeredHost = answers && typeof answers.host === "string" ? answers.host : null;
  const hostLikely = verdict === "likely" && answeredHost === null;
  if (verdict === "cloudways" || answeredHost === "cloudways") return { profile: "cloudways", hostLikely: false };
  const os = environment.os;
  if (os === "darwin" || os === "win32") return { profile: "personal", hostLikely };
  const markers = Array.isArray(environment.containerMarkers) ? environment.containerMarkers : [];
  return { profile: markers.length > 0 ? "container" : "server", hostLikely };
}

function downloadOs(os     ) {
  return os === "darwin" ? "macos" : os === "win32" ? "windows" : "linux";
}

function journeyRoute(journey     ) {
  const route = journey?.currentHealth?.privateRoute;
  return isRecord(route) && typeof route.status === "string" ? route : null;
}

function journeyDaemon(journey     ) {
  const daemon = journey?.currentHealth?.tailnetDaemon;
  return isRecord(daemon) ? daemon : null;
}

function pluginRunsTailscale(profile        , answers      = {}) {
  return profile === "cloudways" || (answers && answers.tailscale === "plugin");
}

function setupNextTailscale(journey     , pluginRun         , tailscaledPresent         ) {
  const route = journeyRoute(journey);
  if (pluginRun) {
    const state = journeyDaemon(journey)?.state;
    if (state === "running") return { tailscale: "running", tailnet: "online" };

    if (state === "needs-authorization") {
      return { tailscale: "running", tailnet: journeyDaemon(journey)?.backend === "NeedsMachineAuth" ? "needs_approval" : "needs_login" };
    }
    if (state === "starting" || state === "stopped" || state === "unknown") return { tailscale: "stopped", tailnet: "needs_login" };
    return { tailscale: tailscaledPresent ? "stopped" : "absent", tailnet: "needs_login" };
  }
  const readCode = route?.route?.readCode ?? route?.evidence;
  if (readCode === "serve_cli_absent") return { tailscale: "absent", tailnet: "needs_login" };
  if (route?.network?.status === "online") return { tailscale: "running", tailnet: "online" };
  return { tailscale: "stopped", tailnet: "needs_login" };
}

function setupNextPhoneAddress(journey     ) {
  const route = journeyRoute(journey);
  if (!route || route.mode !== "custom") return "none";
  if (route.status === "healthy") return "ready";
  if (route.status === "unverified") return "unverified";
  return "wrong";
}

function setupNextRoute(journey     ) {
  const route = journeyRoute(journey);
  const status = route?.status;
  if (status === "healthy") return { route: "ready", stuck: null };
  if (status === "missing" || status === "stale") return { route: "absent", stuck: null };
  if (status === "foreign" || status === "conflicting" || status === "exposed") return { route: "conflict", stuck: null };
  if (status === "unreachable") {

    const cold = route.route?.classification === "ready" && route.ownership?.status === "owned"
      && route.reachability?.frontDoor === "timeout";
    if (cold) return { route: "issuing", stuck: null };
    return { route: "absent", stuck: stuckReport("private_route", "route_unreachable", ["route reachability"]) };
  }
  return { route: "absent", stuck: stuckReport("private_route", "route_unreadable", ["tailscale serve status"]) };
}

function setupNextFirstUse(journey     , answeredNo      = null) {
  const firstUse = isRecord(journey?.firstUse) ? journey.firstUse : null;
  const checkpoints = Array.isArray(journey?.checkpoints) ? journey.checkpoints : [];
  const proof = checkpoints.find((entry     ) => entry && entry.id === "phone-origin-proof");
  if (journey?.coreComplete === true || (proof && proof.status === "complete")) return "confirmed";
  if (!firstUse || firstUse.evidence === "not-started") return "not_armed";

  if (firstUse.status === "awaiting-welcome" || firstUse.wearerConfirmedG2Reply === "confirmed") return "confirmed";
  if (firstUse.replyRunErrored || firstUse.replyWasProviderError === true) return "model_error";
  if (firstUse.status === "unavailable") return "not_armed";
  if (typeof answeredNo === "string" && answeredNo === firstUse.sessionKey) return "answered_no";

  const run = isRecord(firstUse.relayRun) ? firstUse.relayRun : null;
  if (firstUse.status === "awaiting-reply") {
    if (run && run.status === "ended" && (run.outcome === "timed-out" || run.outcome === "phone-changed")) return "no_message";
    return "sending";
  }
  if (firstUse.status === "awaiting-confirmation" && run && run.status === "running") return "sending";

  return "waiting";
}

function setupNextWelcome(journey     ) {
  const firstUse = isRecord(journey?.firstUse) ? journey.firstUse : null;
  if (journey?.coreComplete === true || !firstUse || firstUse.status !== "awaiting-welcome") return "none";
  return isRecord(firstUse.relayRun) && firstUse.relayRun.status === "running" ? "pending" : "none";
}

const JEV_CHECK_FILENAME = JEV_CHECK_FILE;

function readJevCheckFile(stateDir     ) {
  if (typeof stateDir !== "string" || !stateDir) return null;
  const record = readJevCheckRecord(fs, path.join(stateDir, JEV_CHECK_FILE));
  return record ? record.result : null;
}

function jevSetupFromSnapshot(snapshot     ) {
  if (!isRecord(snapshot) || !isRecord(snapshot.diagnostics)) return null;
  const d = snapshot.diagnostics;
  const typesafe = isRecord(snapshot.capabilities) && isRecord(snapshot.capabilities.typesafe) ? snapshot.capabilities.typesafe : {};
  const present = typesafe.present === true;
  return {
    keyAvailable: typeof d.liveuiJevKeyAvailable === "boolean" ? d.liveuiJevKeyAvailable || present : present,

    keyLoaded: present ? typesafe.state === "available_to_test" : null,
    switchOn: d.liveuiJev === true,
    switchLoaded: typeof d.activeLiveuiJev === "boolean" ? d.activeLiveuiJev : null,
  };
}

function setupNextJev(answers     , setup     , check     ) {
  if (!isRecord(answers) || answers.extras !== "jev") return null;
  if (!isRecord(setup) || typeof setup.switchOn !== "boolean") return "unknown";
  if (setup.keyAvailable !== true) return setup.keyAvailable === false ? "no_key" : "unknown";
  const fresh = setup.keyLoaded !== false;
  if (!setup.switchOn) return fresh && check === "key_rejected" ? "key_rejected" : "key_saved";
  if (!fresh || setup.switchLoaded !== true) return "loading";
  if (check === "working" || check === "key_rejected" || check === "unreachable") return check;
  return "not_checked";
}

const CARD_TOOLS_SERVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SETUP_NEXT_CARD_TOOLS_MAX_SERVERS = 32;

function setupNextCardTools(answers     , tools     ) {
  if (!isRecord(answers) || answers.extras !== "card_tools") return null;
  const none = (state        ) => ({ state, servers: []          });
  if (!isRecord(tools) || typeof tools.cards !== "boolean" || typeof tools.mcp !== "boolean") return none("unknown");
  if (!tools.cards) return none("cards_off");
  if (!tools.mcp) return none("switch_off");
  if (typeof tools.reason === "string" && tools.reason) return none("unavailable");
  if (tools.known !== true || !Array.isArray(tools.servers)) return none("unknown");
  const all = tools.servers
    .filter((row     ) => isRecord(row) && typeof row.name === "string" && CARD_TOOLS_SERVER.test(row.name) && row.name !== "host")
    .map((row     ) => ({ name: row.name, connected: row.connected === true, cards: row.cards === true }));
  if (!all.length) return none("no_servers");

  return { state: all.every((row     ) => row.cards) ? "all_on" : "pick", servers: all.slice(0, SETUP_NEXT_CARD_TOOLS_MAX_SERVERS) };
}

function setupNextFacts(read     ) {
  const journey = read.journey || {};
  const answers = isRecord(read.answers) ? read.answers : {};
  const { profile, hostLikely } = setupNextProfile(journey, answers);
  const environment = isRecord(journey.environment) ? journey.environment : {};
  const pluginRun = pluginRunsTailscale(profile, answers);
  const ts = setupNextTailscale(journey, pluginRun, read.tailscaledPresent === true);
  const routeRead = setupNextRoute(journey);
  const checkpoints = Array.isArray(journey.checkpoints) ? journey.checkpoints : [];
  const pairCheckpoint = checkpoints.find((entry     ) => entry && entry.id === "pair-phone");
  const firstUse = setupNextFirstUse(journey, read.answeredNo ?? null);
  const pairing = isRecord(read.pairing) ? read.pairing : {};

  const phoneConnected = !!pairCheckpoint && pairCheckpoint.status === "complete";
  const paired = phoneConnected || pairing.state === "completed" || firstUse === "confirmed";
  const https = read.https === CERT_DOMAINS_UNAVAILABLE ? "off" : read.https === CERT_DOMAINS_AVAILABLE ? "on" : "unknown";
  const seenPhone = phoneConnected ? "present" : !isRecord(read.phone) ? "unknown"
    : read.phone.found === true ? "present" : read.phone.readable === true ? "absent" : "unknown";
  const phone = seenPhone !== "present" && answers.phone === "skip" ? "skipped" : seenPhone;
  const stuck = isRecord(read.stuck) ? read.stuck : routeRead.stuck;
  return {
    lane: "openclaw",
    profile,
    interface: "",
    approvals: true,
    hostLikely,

    model: "signed_in",
    access: read.access === "granted" ? "granted" : "missing",

    loaded: "yes",
    restarted: false,
    phoneAddress: setupNextPhoneAddress(journey),
    tailscale: ts.tailscale,
    tailscaleChoice: answers.tailscale ?? null,
    tailscaleFacts: {
      os: typeof environment.os === "string" ? environment.os : "unknown",
      container: Array.isArray(environment.containerMarkers) && environment.containerMarkers.length > 0,
      systemd: typeof environment.systemdPresent === "boolean" ? environment.systemdPresent : null,

      tailscaleInstalled: ts.tailscale !== "absent" || read.tailscaledPresent === true,
    },
    os: downloadOs(environment.os),
    tailnet: ts.tailnet,
    enrollUrl: typeof read.enrollUrl === "string" && read.enrollUrl ? read.enrollUrl : null,
    https,
    httpsEnableUrl: typeof read.httpsEnableUrl === "string" && read.httpsEnableUrl ? read.httpsEnableUrl : null,
    route: routeRead.route,
    routeCommand: typeof read.routeCommand === "string" ? read.routeCommand : null,
    routeBinding: typeof read.routeBinding === "string" ? read.routeBinding : null,
    phone,
    paired,
    pairingWords: Array.isArray(pairing.words) ? [...pairing.words] : null,
    pairingBinding: typeof pairing.binding === "string" ? pairing.binding : null,
    firstUse,
    welcome: setupNextWelcome(journey),

    beginning: typeof answers.setupBegunAt !== "number",
    jev: setupNextJev(answers, read.jevSetup, read.jevCheck),
    cardTools: setupNextCardTools(answers, read.cardTools),

    tailscaleAdopted: read.tailscaleAdopted === true,
    stuck: stuck ?? null,
  };
}

function setupNextReceiptStuck(receipts     ) {
  const route = receipts && receipts[APPLY_ROUTE_OPERATION];
  if (route && route.status === "failed") {
    return stuckReport("private_route", "route_failed", ["tailscale serve"], ["the approved route command"], route.detail);
  }
  if (route && route.status === "certificate_refused") {
    return stuckReport("private_route", "certificate_refused", ["tailscale cert"], ["the approved route command"]);
  }
  if (route && route.status === "declined") return stuckReport("private_route", "route_declined", ["route approval"]);
  const confirm = receipts && receipts[CONFIRM_PAIRING_OPERATION];
  if (confirm && confirm.status === "failed") return stuckReport("pair", "pairing_failed", ["pairing exchange"]);
  const code = receipts && receipts[PAIR_WITH_PHONE_CODE_OPERATION];
  if (code && code.status === "phone_codes_unavailable") return stuckReport("pair", "pairing_unavailable", ["phone codes"]);
  if (code && code.status === "not_ready") return stuckReport("pair", "pairing_not_ready", ["relay"]);
  if (code && code.status === "failed") return stuckReport("pair", "pairing_failed", ["pairing exchange"]);
  return null;
}

function readSetupNextAnswers(stateDir     ) {
  if (typeof stateDir !== "string" || !stateDir) return {};
  try {
    const document = JSON.parse(fs.readFileSync(path.join(stateDir, SETUP_NEXT_ANSWERS_FILENAME), "utf8"));
    if (!isRecord(document) || document.schemaVersion !== SETUP_NEXT_ANSWERS_SCHEMA || !isRecord(document.answers)) return {};
    const answers                                  = {};
    for (const [key, values] of Object.entries(SETUP_NEXT_ANSWER_KEYS)) {
      const value = document.answers[key];
      if (typeof value === "string" && (values                     ).includes(value)) answers[key] = value;
    }
    for (const key of SETUP_NEXT_MOMENT_KEYS) {
      const value = document.answers[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) answers[key] = value;
    }
    return answers;
  } catch (_) {
    return {};
  }
}

function writeSetupNextAnswers(stateDir     , patch                     ) {
  if (typeof stateDir !== "string" || !stateDir) throw new Error("setup_state_unavailable: no setup state folder");
  const answers = { ...readSetupNextAnswers(stateDir), ...patch };
  for (const key of Object.keys(answers)) if (answers[key] === null || answers[key] === undefined) delete answers[key];
  const filePath = path.join(stateDir, SETUP_NEXT_ANSWERS_FILENAME);
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: SETUP_NEXT_ANSWERS_SCHEMA, answers }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
  return answers;
}

function validateSetupNextParams(params     ) {
  const ok = isRecord(params) && params.operation === SETUP_NEXT_OPERATION
    && Object.keys(params).every((key) => key === "operation" || key === "choice")
    && (params.choice === undefined
      || (typeof params.choice === "string" && params.choice.length > 0 && params.choice.length <= SETUP_NEXT_CHOICE_MAX));
  if (!ok) {
    const err      = new Error("invalid_input: next takes only an optional choice");
    err.code = "invalid_input";
    throw err;
  }
}

const memory = new Map                         ();

function memoryFor(stateDir     ) {
  const key = typeof stateDir === "string" ? stateDir : "";
  let entry = memory.get(key);
  if (!entry) {
    entry = { enrollUrl: null, lastNextAt: 0, answeredNo: null, retryFirstUse: false, accessGranted: false };
    memory.set(key, entry);
  }
  return entry;
}

function resetSetupNextMemoryForTests() {
  memory.clear();
}

function tailscaleRun(argv     ) {
  return (args     ) => defaultRunTailscale(args, argv);
}

function defaultDeps(api     , controller     , firstUse     ) {
  const stateDir = () => resolveSetupStateDir(api);
  const layout = () => resolveLayout({});
  const routeArgv = () => chatRouteTailscaleArgv();
  return {
    stateDir,
    now: () => Date.now(),
    sleep: (ms        ) => new Promise((resolve     ) => setTimeout(resolve, ms)),
    readJourney: () => controller(SETUP_NEXT_JOURNEY, { surface: "tool" }),    readAccess: () => {
      let config      = null;
      try {
        const runtimeConfig = api && api.runtime ? api.runtime.config : null;
        config = runtimeConfig && typeof runtimeConfig.current === "function" ? runtimeConfig.current() : null;
      } catch (_) { config = null; }
      return conversationAccessGranted(config ?? (api ? api.config : null)) ? "granted" : "missing";
    },
    tailscaledPresent: () => binariesPresent(layout()),
    readHttps: () => readCertDomains(tailscaleRun(routeArgv())),
    readHttpsEnableUrl: async (pluginRun         ) => (pluginRun ? queryHttpsEnableLink(layout().socketPath) : null),
    readPhone: () => readPhonePresence(tailscaleRun(routeArgv())),
    routeCommand: (relayPort     ) => chatRouteCommand(relayPort),

    readJevSnapshot: () => null,
    readJevCheck: (dir     ) => readJevCheckFile(dir),

    readCardTools: (_opts     ) => null,
    store: { pendingRouteApproval, pendingPairing, pairingStatus, lastSetupReceipt },
    firstUse,
    runs: {
      grant_access: () => defaultGrantConversationAccess(api)(),

      start_tailscale: async () => {
        const l = layout();
        return readTailscaleCliReceipt(l.hostStateDir || resolveHostStateDir(process.env)) ? startDaemon(l) : cloudwaysInstall(l);
      },
      enroll: () => cloudwaysEnroll(layout(), {}, { waitS: 30, timeoutS: 25 }),
      issue_certificate: (relayPort     , route     ) => awaitRouteCertificate({
        relayPort,
        route,
        readRoute: defaultReadRoute(api, {}),
        startCertificate: async (budgetMs     ) => {
          const argv = routeArgv();
          const node      = await readNodeState(tailscaleRun(argv));
          if (!node || !node.dnsName) return null;
          return startCertificateIssuance(argv, node.dnsName, budgetMs);
        },
        certificateWaitMs: NEXT_CERTIFICATE_WAIT_MS,
      }),
    },
  };
}

const SETUP_NEXT_JOURNEY = "journey";

async function settle(promise     ) {
  try { return await promise; } catch (_) { return null; }
}

function createSetupNext(api     , controller     , firstUse      = null, deps      = {}) {
  const defaults      = defaultDeps(api, controller, firstUse);
  const given      = isRecord(deps) ? deps : {};
  const d      = { ...defaults, ...given };
  d.runs = { ...defaults.runs, ...(isRecord(given.runs) ? given.runs : {}) };
  d.store = { ...defaults.store, ...(isRecord(given.store) ? given.store : {}) };

  async function readPairing(stateDir     , freshCode         ) {
    const deadline = d.now() + NEXT_PAIRING_WAIT_MS;
    for (;;) {
      const words = await settle(d.store.pendingPairing(stateDir));
      const state = (d.store.pairingStatus(stateDir) || {}).state;
      if (words) return { state, words: words.words, binding: words.binding };
      const waiting = (state === "waiting_for_phone" && freshCode) || state === "approved";
      if (!waiting || d.now() >= deadline) return { state };
      await d.sleep(NEXT_POLL_MS);
    }
  }

  async function read(stateDir     , mem     , runStuck     ) {
    const journey      = await settle(d.readJourney());
    if (!isRecord(journey) || !isRecord(journey.currentHealth)) {
      const err      = new Error("setup_unavailable: the setup state could not be read; call next again");
      err.code = "setup_unavailable";
      throw err;
    }
    const answers = readSetupNextAnswers(stateDir);
    const base      = {
      journey,
      answers,

      access: mem.accessGranted ? "granted" : d.readAccess(),
      tailscaledPresent: !!d.tailscaledPresent(),
      enrollUrl: mem.enrollUrl,
      answeredNo: mem.answeredNo,
      tailscaleAdopted: mem.adoptedNow === true,
    };

    if (answers.extras === "jev") {
      base.jevSetup = jevSetupFromSnapshot(await settle(d.readJevSnapshot()));
      base.jevCheck = await settle(d.readJevCheck(stateDir));
    }

    if (answers.extras === "card_tools" && setupNextFacts(base).paired) {
      base.cardTools = await settle(Promise.resolve().then(() => d.readCardTools({ servers: true })));
    }
    let facts      = setupNextFacts(base);
    if (facts.tailnet === "online") mem.enrollUrl = null;
    const receipts                      = {};
    for (const op of [APPLY_ROUTE_OPERATION, CONFIRM_PAIRING_OPERATION, PAIR_WITH_PHONE_CODE_OPERATION]) {
      const last = d.store.lastSetupReceipt(stateDir, op);
      if (last && Number(last.at) > mem.lastNextAt) receipts[op] = last;
    }
    const customRoute = facts.phoneAddress !== "none";

    if (!customRoute && facts.tailnet === "online" && facts.route === "absent") {
      base.https = receipts[APPLY_ROUTE_OPERATION]?.status === "https_off" ? CERT_DOMAINS_UNAVAILABLE : await settle(d.readHttps());
      if (base.https === CERT_DOMAINS_UNAVAILABLE) {
        base.httpsEnableUrl = await settle(d.readHttpsEnableUrl(pluginRunsTailscale(facts.profile, answers)));
      }
      const relayPort = journey?.currentHealth?.privateRoute?.relay?.port;
      if (Number.isInteger(relayPort) && relayPort > 0) {
        try {
          const command = d.routeCommand(relayPort);
          base.routeCommand = command;
          base.routeBinding = d.store.pendingRouteApproval(stateDir, command).binding;
        } catch (_) {  }
      }
    }

    if (!customRoute && facts.route === "ready") base.phone = await settle(d.readPhone());
    if (!facts.paired && (customRoute || facts.route === "ready")) {
      base.pairing = await readPairing(stateDir, !!receipts[PAIR_WITH_PHONE_CODE_OPERATION]);
    }
    base.stuck = runStuck ?? setupNextReceiptStuck(receipts);
    facts = setupNextFacts(base);
    return { facts, journey };
  }

  async function answer(stateDir     , result     , choice        , signal     , ctx     ) {
    const input = result && result.input;
    if (!input || input.kind !== "choice" || !Array.isArray(input.options)) return;
    if (!input.options.some((option     ) => option && option.id === choice)) {
      const err      = new Error(`invalid_input: choice must be one of ${input.options.map((o     ) => o.id).join(", ")}`);
      err.code = "invalid_input";
      throw err;
    }
    if (result.step === "host_model") writeSetupNextAnswers(stateDir, { host: choice });
    else if (result.step === "private_network") writeSetupNextAnswers(stateDir, { tailscale: choice });
    else if (result.step === "phone_on_tailnet" && choice === "skip") writeSetupNextAnswers(stateDir, { phone: "skip" });
    else if (result.step === "first_message" && typeof d.firstUse === "function") {

      const waited      = await settle(d.firstUse({ operation: "first_use_wait", timeoutMs: NEXT_FIRST_USE_WAIT_MS }, signal, ctx));
      if (!waited || waited.status !== "awaiting-confirmation" || typeof waited.binding !== "string") return;
      const confirmed      = await settle(d.firstUse({ operation: "first_use_confirm", binding: waited.binding, answer: choice }, signal, ctx));
      memoryFor(stateDir).answeredNo = choice === "no" && confirmed ? (waited.sessionKey ?? null) : null;
    }
  }

  async function run(name        , journey     , signal     , ctx     , mem     ) {
    const step = RUN_STEP[name];
    try {
      if (name === "grant_access") {
        await d.runs.grant_access();
        mem.accessGranted = true;
        return null;
      }
      if (name === "start_tailscale") {
        const report      = await d.runs.start_tailscale();
        const failed = !report || report.ok === false || report.error
          || report.action === "start-failed" || report.action === "refused" || report.action === "absent";
        if (!failed) {

          if (report.adopted && typeof report.adopted === "object") mem.adoptedNow = true;
          return null;
        }
        const detail = typeof report?.error === "string" ? report.error : typeof report?.detail === "string" ? report.detail : null;
        return stuckReport(step, "tailscale_start_failed", ["tailscaled"], ["start Tailscale"], detail ? detail.slice(0, 160) : null);
      }
      if (name === "enroll") {
        const report      = await d.runs.enroll();
        if (report && typeof report.authUrl === "string" && report.authUrl.startsWith("https://")) {
          mem.enrollUrl = report.authUrl;
          return null;
        }
        if (report && report.ok === true) return null;
        return stuckReport(step, "enroll_failed", ["tailscale up"], ["ask Tailscale for the approval link"]);
      }
      if (name === "issue_certificate") {
        const route = journey?.currentHealth?.privateRoute ?? null;
        const waited      = await d.runs.issue_certificate(route?.relay?.port, route);
        if (waited && waited.outcome === CERTIFICATE_WAIT_REFUSED) {
          return stuckReport(step, "certificate_refused", ["tailscale cert"], ["wait for the certificate"]);
        }
        return null;
      }
      if (name === "arm_first_use") {
        const begun      = typeof d.firstUse === "function"
          ? await d.firstUse({ operation: "first_use_begin" }, signal, ctx)
          : { status: "unavailable" };
        if (!begun || begun.status === "unavailable") {
          return stuckReport(step, "first_use_unavailable", ["first message check"], ["arm the first message check"]);
        }
        return null;
      }
    } catch (_) {
      const code = name === "grant_access" ? "grant_access_failed"
        : name === "start_tailscale" ? "tailscale_start_failed"
        : name === "enroll" ? "enroll_failed"
        : name === "arm_first_use" ? "first_use_unavailable"
        : "route_unreachable";
      return stuckReport(step, code, [], [name.replace(/_/g, " ")]);
    }
    return null;
  }

  return async function setupNext(params     , signal      = null, ctx      = null) {
    validateSetupNextParams(params);
    const stateDir = d.stateDir();
    const mem = memoryFor(stateDir);
    let runStuck      = null;
    mem.adoptedNow = false;
    let decided      = null;
    let journey      = null;

    if (mem.retryFirstUse && typeof d.firstUse === "function") {
      mem.retryFirstUse = false;
      mem.answeredNo = null;
      await settle(d.firstUse({ operation: "first_use_retry" }, signal, ctx));
    }
    if (params.choice !== undefined) {
      const first = await read(stateDir, mem, null);
      await answer(stateDir, decideNext(first.facts).result, params.choice, signal, ctx);
    }
    const ran = new Set        ();
    for (let i = 0; i < MAX_DECISIONS; i += 1) {
      const current = await read(stateDir, mem, runStuck);
      journey = current.journey;
      decided = decideNext(current.facts);
      const next = decided.run;

      if (!next || next === "restart" || ran.has(next) || runStuck) break;
      ran.add(next);
      runStuck = await run(next, journey, signal, ctx, mem);
    }
    mem.lastNextAt = d.now();

    if (decided.result.say[0] === SETUP_SAY.beginning) writeSetupNextAnswers(stateDir, { setupBegunAt: d.now() });
    const stuckCode = decided.result.stuck?.code;
    mem.retryFirstUse = decided.result.step === "first_message"
      && (stuckCode === "reply_not_shown" || stuckCode === "model_error" || stuckCode === "first_message_missing");
    const checked = validateNextResult(decided.result);
    if (!checked.ok) {
      const err      = new Error(`setup_next_invalid: ${checked.error}`);
      err.code = "setup_next_invalid";
      throw err;
    }
    return decided.result;
  };
}

module.exports = { SETUP_NEXT_OPERATION, SETUP_NEXT_ANSWERS_FILENAME, SETUP_NEXT_ANSWERS_SCHEMA, SETUP_NEXT_ANSWER_KEYS, SETUP_NEXT_MOMENT_KEYS, SETUP_NEXT_CHOICE_MAX, NEXT_CERTIFICATE_WAIT_MS, NEXT_FIRST_USE_WAIT_MS, NEXT_PAIRING_WAIT_MS, NEXT_POLL_MS, setupNextProfile, pluginRunsTailscale, setupNextTailscale, setupNextPhoneAddress, setupNextRoute, setupNextFirstUse, setupNextWelcome, JEV_CHECK_FILENAME, readJevCheckFile, jevSetupFromSnapshot, setupNextJev, SETUP_NEXT_CARD_TOOLS_MAX_SERVERS, setupNextCardTools, setupNextFacts, setupNextReceiptStuck, readSetupNextAnswers, writeSetupNextAnswers, validateSetupNextParams, resetSetupNextMemoryForTests, createSetupNext };
