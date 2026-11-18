const { runCloudwaysVerb } = require("./cloudways-command.cjs");
const { terminalText } = require("./terminal-text.cjs");
const { cliArgv, defaultRunCommand, DETECT_CLOUDWAYS, gatewayProcessRunning, resolveLayout, STALE_ENROLLMENT_MESSAGE, STATE_NEEDS_AUTH, STATE_RUNNING } = require("./cloudways.cjs");
const { PLUGIN_VERSION } = require("../version.cjs");
const { applyCommand, CERT_DOMAINS_AVAILABLE, CERT_DOMAINS_UNAVAILABLE, CERT_DOMAINS_UNKNOWN, defaultRunTailscale, LOOPBACK, readCertDomains, readNodeState, readPhonePresence, ROUTE_STATUS_CONFLICTING, ROUTE_STATUS_EXPOSED, ROUTE_STATUS_FOREIGN, ROUTE_STATUS_HEALTHY, servePort } = require("./private-route.cjs");
const { ISSUANCE_AVAILABLE, ISSUANCE_UNAVAILABLE, ISSUANCE_UNKNOWN, queryHttpsEnableLink, startCertificateIssuance } = require("./certificate-issuance.cjs");
const { readPrivateRoute } = require("./setup-live.cjs");
const { configuredPhoneAddress } = require("./custom-route.cjs");
const { setupInstallation } = require("./setup-journey.cjs");
const { resolveSetupStateDir } = require("./setup-controller.cjs");
const { createRelayCredentialProvision, PROVISION_RELAY_CREDENTIAL_OPERATION, readCodexConfigTomlsSafely } = require("./relay-credential-provision.cjs");
const { applyCodexReasoningSummary, planCodexReasoningSummary } = require("./codex-reasoning-summary.cjs");
const { applyConversationAccessGrant, CONVERSATION_ACCESS_CONFIG_PATH, conversationAccessGranted } = require("./conversation-access.cjs");
const { createFirstUseCommand, runSetupWelcome, setupFirstUseRequest } = require("./first-use-command.cjs");
const { awaitFirstUseReply, FIRST_USE_SEND_TEXT: FIRST_USE_SEND_TEXT_VALUE, FIRST_USE_ALREADY_COMPLETE_MESSAGE: FIRST_USE_ALREADY_COMPLETE_VALUE, FIRST_USE_REPLY_MESSAGE: FIRST_USE_REPLY_VALUE, FIRST_USE_DEFAULT_RESUME_COMMAND, createGatewayFreezeRider, gatewayUnresponsiveMessage, isGatewayUnresponsive, GATEWAY_UNRESPONSIVE_REASON } = require("./first-use-wait.cjs");
const { createRuntimeConfigOverview } = require("../config/runtime-config.cjs");
const process = require("node:process");

const SETUP_STEP_COUNT = 8;

const SETUP_EXIT_OK = 0;
const SETUP_EXIT_PROBLEM = 1;
const SETUP_EXIT_STOPPED = 2;

const CONSENT_ANSWER = "yes";
const CONSENT_QUESTION = `Allow access? Type ${CONSENT_ANSWER} or y; anything else stops: `;

const CONSENT_ANSWERS = Object.freeze([CONSENT_ANSWER, "y"]);

const CONSENT_QUESTION_STRICT = `Apply route? Type the full word ${CONSENT_ANSWER}; anything else stops: `;

function consentGiven(answer     , strict      = false) {
  const typed = String(answer).trim().toLowerCase();
  return strict === true ? typed === CONSENT_ANSWER : CONSENT_ANSWERS.indexOf(typed) !== -1;
}

const EMPTY_ANSWER_ASKS = 3;
const EMPTY_ANSWER_MESSAGE = "I didn't catch that. Type it again.";

const NOT_CLOUDWAYS_MESSAGE =
  "This command is for Cloudways Managed AI Agents.\nUse the ordinary OcuClaw setup for this machine.";

const TTY_REQUIRED_MESSAGE =
  "Run this command in an interactive terminal.\nFor automation, --yes approves setup changes; it cannot approve pairing or confirm a glasses reply.";

const RESUME_MESSAGE =
  "Stopped. Earlier changes are kept. Run the same setup command to resume.";

const DROPPED_TERMINAL_MESSAGE = "If your terminal drops, run the same command again.";

const COLD_CERTIFICATE_MESSAGE =
  "Waiting for the certificate. This usually takes a minute or two.";

function certificateProgressMessage(elapsedS     ) {
  return `Still waiting for the certificate (${waitedFor(elapsedS)} so far).`;
}

function waitedFor(elapsedS     ) {
  const total = Math.max(0, Math.floor(Number(elapsedS) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const parts      = [];
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (seconds > 0 || minutes === 0) parts.push(`${seconds} seconds`);
  return parts.join(" ");
}

const PROGRESS_SIGN_IN_MESSAGE = "Checking the model sign-in...";
const PROGRESS_LOADED_MESSAGE = "Checking that OcuClaw is loaded...";
const PROGRESS_TAILSCALE_MESSAGE = "Checking Tailscale...";
const PROGRESS_TAILSCALE_INSTALL_MESSAGE = "Installing Tailscale...";

const TAILSCALE_MOVE_MESSAGE =
  "Switching to the Tailscale this server ships. Same node and sign-in, nothing to approve.";
const PROGRESS_ENROLL_MESSAGE = "Getting the approval link from Tailscale...";
const PROGRESS_ROUTE_MESSAGE = "Checking the private route...";
const PROGRESS_PHONE_MESSAGE = "Checking for your phone...";

function firstUseWaitingProgress(elapsedS     ) {
  return `Waiting for the phone reply (${waitedFor(elapsedS)} so far).`;
}

function commandWords(text     ) {
  const words      = [];
  let word = "";
  let quote      = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      word += ch;
      if (ch === quote) quote = null;
    } else if (ch === "\\" && i + 1 < text.length) {
      word += ch + text[i + 1];
      i += 1;
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
      word += ch;
    } else if (ch === " ") {
      if (word) words.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word) words.push(word);
  return words;
}

function wrapCommandLines(command     , columns      = 0, indent = "    ", continuation = "      ") {
  const text = String(command);
  const width = Number(columns) > 0 ? Math.floor(Number(columns)) : 0;
  const whole = `${indent}${text}`;

  if (width === 0 || whole.length < width) return [whole];
  const words = commandWords(text);
  if (words.length < 2) return [whole];
  const lines      = [];
  let current = `${indent}${words[0]}`;
  for (let i = 1; i < words.length; i += 1) {
    const last = i === words.length - 1;
    const candidate = `${current} ${words[i]}`;

    if (candidate.length + (last ? 0 : 2) < width) {
      current = candidate;
      continue;
    }
    lines.push(`${current} \\`);
    current = `${continuation}${words[i]}`;
  }
  lines.push(current);
  return lines;
}

const CERTIFICATE_TIMEOUT_MESSAGE =
  "The certificate is not ready yet. Run the same command again; setup picks up here.";

const CERTIFICATE_REFUSED_MESSAGE =
  "Tailscale cannot issue this server's certificate. Check that HTTPS is on for your Tailscale account at https://console.tailscale.com/admin/dns, then run the same command again; setup picks up here.";

const HTTPS_OFF_MESSAGE =
  "Your Tailscale account has HTTPS turned off. Your phone's private route needs it.";
const HTTPS_ENABLE_LINK_LINE = "Open this link, sign in to Tailscale and turn on HTTPS:";
const HTTPS_ADMIN_PAGE_LINE =
  "Open this page, sign in to Tailscale and turn on MagicDNS and HTTPS Certificates:";
const HTTPS_ADMIN_PAGE_URL = "https://console.tailscale.com/admin/dns";
const HTTPS_CARRIES_ON_MESSAGE = "Setup carries on by itself once it is on.";
const HTTPS_WAITING_MESSAGE = "Waiting for HTTPS to be turned on.";
const HTTPS_ON_MESSAGE = "HTTPS is on.";
const HTTPS_TIMEOUT_MESSAGE =
  "HTTPS is still off, so setup stopped here. Turn it on, then run the same command again; setup picks up here.";

const PAIR_RETRY_NO_ANSWER_MESSAGE =
  "No answer, so setup stopped here. Run the same command again to get a new code.";

const ROUTE_NOT_OURS_STATUSES = Object.freeze([ROUTE_STATUS_FOREIGN, ROUTE_STATUS_CONFLICTING, ROUTE_STATUS_EXPOSED]);
const ROUTE_NOT_OURS_MESSAGE =
  "Something else already uses OcuClaw's private route port on this machine, so setup won't replace it. Remove that route, then run this setup again.";

const STUCK_HELP_MESSAGE = "Stuck? Ask us on Discord: https://discord.ocuclaw.com";

const OCUCLAW_LOADED_MESSAGE = "OcuClaw is loaded and ready.";

const OCUCLAW_NOT_LOADED_MESSAGE =
  "OcuClaw is installed but your agent has not loaded it yet.";

function ocuclawOldVersionMessage(loaded     , installed     ) {
  return `Your agent is still running OcuClaw ${loaded}. OcuClaw ${installed} is installed.`;
}

const CLOUDWAYS_RESTART_COMMAND = "pkill -f openclaw-gateway";
const CLOUDWAYS_RESTART_WARNING_LINES = [
  "This restarts the whole container, so SSH will drop. Reconnect in about a minute.",
  "Your phone reconnects in 1–5 minutes. Active replies are stopped, not finished.",
];
const SETUP_COMMAND = "openclaw ocuclaw cloudways setup";

const OCUCLAW_NOT_LOADED_HELP_LINES = [
  "  This host normally loads the plugin without a restart.",
  "  If OcuClaw stays unloaded, run openclaw ocuclaw doctor.",
];
const OCUCLAW_RESTART_LINES = [
  "  One restart loads OcuClaw. Type:",
  `    ${CLOUDWAYS_RESTART_COMMAND}`,
  ...CLOUDWAYS_RESTART_WARNING_LINES.map((line) => `  ${line}`),
  "  After you reconnect, type this again:",
  `    ${SETUP_COMMAND}`,
  "  Or restart the agent from your Cloudways dashboard.",
];

const CLOUDWAYS_DASHBOARD_RESTART_MESSAGE =
  `Restart the agent from your Cloudways dashboard, then run ${SETUP_COMMAND} again.`;
const OCUCLAW_DASHBOARD_RESTART_LINES = [
  `  ${CLOUDWAYS_DASHBOARD_RESTART_MESSAGE}`,
  `  ${CLOUDWAYS_RESTART_WARNING_LINES[0]}`,
];

const WEB_TERMINAL_RESTART_LINE =
  "This restarts your agent and closes this terminal. In about a minute, open /terminal again.";
const OCUCLAW_WEB_TERMINAL_RESTART_LINES = OCUCLAW_RESTART_LINES.map((line) => {
  if (line === `  ${CLOUDWAYS_RESTART_WARNING_LINES[0]}`) return `  ${WEB_TERMINAL_RESTART_LINE}`;
  if (line === "  After you reconnect, type this again:") return "  Then type this again:";
  return line;
});
const OCUCLAW_WEB_TERMINAL_DASHBOARD_RESTART_LINES = [
  `  ${CLOUDWAYS_DASHBOARD_RESTART_MESSAGE}`,
  `  ${WEB_TERMINAL_RESTART_LINE}`,
];

function ocuclawRestartLines(state      = {}) {
  const web = state.webTerminal === true;
  if (state.gatewayRunning === false) {
    return (web ? OCUCLAW_WEB_TERMINAL_DASHBOARD_RESTART_LINES : OCUCLAW_DASHBOARD_RESTART_LINES).slice();
  }
  const phoneLine = `  ${CLOUDWAYS_RESTART_WARNING_LINES[1]}`;
  const lines = web ? OCUCLAW_WEB_TERMINAL_RESTART_LINES : OCUCLAW_RESTART_LINES;
  return state.phonePaired === true
    ? lines.slice()
    : lines.filter((line) => line !== phoneLine);
}

const LOADED_CHECK_WAIT_MS = 480000;
const LOADED_CHECK_RETRY_MS = 5000;

const PROGRESS_LOADED_WAIT_MESSAGE = "Still checking. This can take up to 8 minutes.";

const LOADED_PROGRESS_EVERY_MS = 60000;
function loadedProgressMessage(elapsedS     ) {
  return `Still checking that OcuClaw is loaded (${waitedFor(elapsedS)} so far).`;
}

const MODEL_STATUS_ARGV = Object.freeze(["openclaw", "models", "status", "--json"]);
const MODEL_PANEL_PATH = "LLM & Channels → OAuth → OpenAI → Connect";

const MODEL_PANEL_SIGN_IN_LINES = Object.freeze([
  "  No model is signed in yet. Sign in to OpenAI in the Cloudways panel:",
  `    ${MODEL_PANEL_PATH}`,
  "  Using ChatGPT? First turn on device code sign-in in ChatGPT: Settings → Security and login.",
  "  Your agent restarts after that. It can take a few minutes.",
  "  When it is back, run this again:",
]);

function modelPanelSignInLines(command      = SETUP_COMMAND) {
  return [...MODEL_PANEL_SIGN_IN_LINES, `    ${command}`];
}

function modelSignedIn(document     ) {
  if (!isRecord(document)) return null;
  const models = [document.resolvedDefault, document.defaultModel]
    .filter((value     ) => typeof value === "string" && value.trim() !== "")
    .map((value        ) => value.trim());
  if (models.length === 0) return false;
  const auth = isRecord(document.auth) ? document.auth : null;
  if (!auth || !Array.isArray(auth.missingProvidersInUse)) return null;
  if (auth.missingProvidersInUse.length > 0) return false;
  const issues = Array.isArray(auth.modelRouteIssues)
    ? auth.modelRouteIssues.filter((issue     ) => isRecord(issue) && routeIssueNamesModel(issue, models))
    : [];
  if (issues.some((issue     ) => issue.kind === "missing-auth")) return false;
  if (issues.some((issue     ) => issue.kind === "indeterminate") && modelAuthHoldsNoCredential(auth) === true) {
    return false;
  }
  return true;
}

function routeIssueNamesModel(issue     , models          ) {
  const provider = typeof issue.provider === "string" ? issue.provider.trim() : "";
  const model = typeof issue.model === "string" ? issue.model.trim() : "";
  if (!provider || !model) return true;
  const ref = `${provider}/${model}`;
  return models.some((value) => value === ref || value === model);
}

function modelAuthHoldsNoCredential(auth     ) {
  const oauth = isRecord(auth.oauth) ? auth.oauth : null;
  if (!Array.isArray(auth.providersWithOAuth) || !oauth || !Array.isArray(oauth.profiles)) return null;
  if (!Array.isArray(auth.providers)) return null;
  if (auth.providersWithOAuth.length > 0 || oauth.profiles.length > 0) return false;
  const holdsKey = auth.providers.some((entry     ) => {
    if (!isRecord(entry)) return false;
    const profiles = isRecord(entry.profiles) ? entry.profiles : {};
    const counted = ["apiKey", "oauth", "token"]
      .some((key) => typeof profiles[key] === "number" && profiles[key] > 0);
    return counted || isRecord(entry.env) || isRecord(entry.modelsJson);
  });
  return !holdsKey;
}

const ENROLL_ON_PHONE_LINES = [
  "  On your phone, sign in to Tailscale. Open this link to approve this server:",
];
const ENROLL_INSTALL_TAILSCALE_LINE =
  "  No Tailscale on your phone? Install it from the App Store or Google Play and sign in first.";

const ENROLL_WEB_LINK_LINE = "  Open this link and sign in to Tailscale to approve this server:";
const ENROLL_WEB_ACCOUNT_LINES = [
  "  Use the Tailscale account your phone uses.",
  "  No Tailscale on your phone? Install it from the App Store or Google Play.",
];

function tailnetNameSuffix(daemon     )                {
  if (!daemon || typeof daemon !== "object") return null;
  const asked = typeof daemon.nodeName === "string" ? daemon.nodeName.trim().toLowerCase() : "";
  const dnsName = typeof daemon.dnsName === "string" ? daemon.dnsName.trim().toLowerCase() : "";
  const given = dnsName.split(".")[0];
  if (!asked || !given.startsWith(`${asked}-`)) return null;
  const suffix = given.slice(asked.length);
  return /^-[0-9]+$/.test(suffix) ? suffix : null;
}

function tailnetSuffixLine(suffix        )         {
  return `  Tailscale added ${suffix} because old devices with this name are still in your tailnet.`;
}

const PHONE_PRESENT_MESSAGE = "Phone found on your Tailscale network.";

const PHONE_WALKTHROUGH_LINES = [
  "Phone not found on your Tailscale network.",
  "",
  "On your phone:",
  "1. Open Tailscale.",
  "2. Sign in with the same account as this server.",
  "3. Switch Tailscale on.",
  "",
  "Waiting for your phone. Press Enter to skip this check.",
];

const PHONE_NO_TERMINAL_MESSAGE =
  "No phone found on your Tailscale network.\nPhone check skipped: this terminal is not interactive.";

const PHONE_APPEARED_MESSAGE = "Phone found on your Tailscale network.";

const PHONE_CARRY_ON_MESSAGE = "Phone check skipped. No phone was found on your Tailscale network.";

const PHONE_WAIT_TIMEOUT_MESSAGE =
  "No phone found before the check timed out.\nTurn on Tailscale on your phone, then run setup again.";

const PAIR_OPEN_APP_MESSAGE = "Open Even > OcuClaw on your phone.";

const PAIR_READY_LINES = [
  "In OcuClaw tap Pair with your agent > Pair manually, then press Enter to show the code.",
  "The next pairing code expires in 5 minutes.",
];

const PAIR_RETRY_PROMPT_MESSAGE =
  "Press Enter for a new code, or type stop:";

const PAIR_RETRY_STOP_ANSWER = "stop";

const PAIR_RETRY_LIMIT = 3;

const PAIR_TIMEOUT_CAUSE_LINES = Object.freeze([
  "Most often this means Tailscale is switched off,",
  "or signed in to a different account, on your phone.",
]);

const PAIR_SCREEN_NOT_OPEN_MESSAGE = "If the pair screen wasn't open yet, open it first.";

const PAIR_NOBODY_ENTERED_MESSAGE = "Code expired before a phone joined.";

const PAIR_WINDOW_EXPIRED_MESSAGE = "Pairing took longer than the five-minute window.";

function pairingExpiryMessage(phase     , reason      = null) {
  if (phase === "waiting-for-phone") return PAIR_NOBODY_ENTERED_MESSAGE;
  if (reason === "expired" && (phase === "awaiting-approval" || phase === "awaiting-phone-connection")) {
    return PAIR_WINDOW_EXPIRED_MESSAGE;
  }
  if (phase === "awaiting-approval") return "Pairing expired while waiting for approval.";
  if (phase === "awaiting-phone-connection") return "Approval was sent, but your phone's connection was not confirmed in time. Check your phone before retrying.";
  return "Pairing did not finish before the code expired.";
}

const { FIRST_USE_SEND_TEXT, FIRST_USE_ALREADY_COMPLETE_MESSAGE, FIRST_USE_WAITING_MESSAGE, FIRST_USE_REARMED_MESSAGE, FIRST_USE_RECONNECTED_MESSAGE, FIRST_USE_RECONNECT_REARMS, FIRST_USE_REPLY_MESSAGE, FIRST_USE_OPEN_APP_NOTICE, FIRST_USE_RESUME_COMMAND, GATEWAY_SLOW_MESSAGE } = require("./first-use-wait.cjs");

const FIRST_USE_SKIPPED_MESSAGE =
  "First-message check skipped.\nWhen ready, run openclaw ocuclaw first-use.";

const FIRST_USE_RECOVERY_LINE =
  `To try again, run ${FIRST_USE_DEFAULT_RESUME_COMMAND} and send a fresh message.`;

const FIRST_USE_STOP_SENTENCES                                   = Object.freeze({

  "setup-session-mismatch": "Your phone switched to a different chat.",

  "setup-phone-binding-changed": "Your phone's connection to this server changed.",

  "setup-attempt-required": "No saved check was found on this server.",

  "setup-session-required": "Setup could not tell which chat to watch.",

  "setup-phone-session-ambiguous-or-disconnected": "No phone is connected, or more than one is.",

  "setup-phone-session-unavailable": "Your phone is connected but has no chat open.",
  "setup-state-unavailable": "Setup could not find its saved progress.",
  "setup-state-unreadable-or-foreign": "Setup could not read its saved progress.",
  "setup-state-locked": "Setup's saved progress was locked.",
  "installation-mismatch": "OpenClaw is running a different OcuClaw install.",
  "runtime-unavailable": "OcuClaw is not running in OpenClaw right now.",
  "setup-first-use-unavailable": "OpenClaw could not run the check right now.",
});
const FIRST_USE_STOP_FALLBACK = "Something went wrong on this server.";

function firstUseStopSentence(reason     ) {
  return Object.prototype.hasOwnProperty.call(FIRST_USE_STOP_SENTENCES, reason)
    ? FIRST_USE_STOP_SENTENCES[reason]
    : FIRST_USE_STOP_FALLBACK;
}

const FIRST_USE_PHONE_SETTLE_MS = 30000;

const FIRST_USE_UNAVAILABLE_MESSAGE =
  "Setup cannot start the first-message check on this host.\nRun openclaw ocuclaw first-use in your terminal.";

const FIRST_USE_REPLY_ERROR_MESSAGE =
  "The model returned an error. No first reply was confirmed.\nOcuClaw is installed; setup is not complete.\n\nFix the model account or configuration, then resume:\n  openclaw ocuclaw cloudways setup";

const FIRST_USE_REPLY_RATE_LIMIT_MESSAGE =
  "The model is rate limited. No first reply was confirmed.\nOcuClaw is installed; setup is not complete.\n\nWait for the limit to reset or choose another model, then run:\n  openclaw ocuclaw cloudways setup";

const FIRST_USE_TIMEOUT_MESSAGE =
  "No reply arrived before the check timed out.\nKeep Tailscale on your phone switched on, then run setup again.";

const FIRST_USE_PENDING_MESSAGE =
  "Glasses reply confirmation is still pending.\nRun setup again when you are ready.";

const SETUP_COMPLETE_MESSAGE = "Setup is complete.";

const FIRST_USE_TEST_INPUT_MESSAGE =
  "Test input used. No wearer confirmation was recorded.";

const FIRST_USE_WELCOME_UNAVAILABLE_MESSAGE =
  "Setup is not complete: the glasses welcome still needs a double-tap.\nThis host could not show it. When ready, run openclaw ocuclaw first-use.";

const DEFAULT_ENROLL_WAIT_S = 600;
const DEFAULT_FIRST_USE_WAIT_S = 600;
const DEFAULT_PHONE_WAIT_S = 600;
const DEFAULT_PHONE_POLL_MS = 3000;

const ENTER_SETTLE_MS = 150;

const ANSWER_WAIT_MS = 600000;
const DEFAULT_POLL_MS = 5000;
const DEFAULT_NOTICE_MS = 30000;

const DEFAULT_CERTIFICATE_WAIT_MS = 300000;

const DEFAULT_HTTPS_WAIT_MS = 600000;
const CERTIFICATE_PROGRESS_MS = 30000;

const CERTIFICATE_RETRY_MS = 30000;

const CERTIFICATE_MAX_CALLS = 3;

const CERTIFICATE_QUICK_FAIL_MS = 2000;

function isRecord(value     ) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const CERTIFICATE_WAIT_HEALTHY = "healthy";
const CERTIFICATE_WAIT_REFUSED = "refused";
const CERTIFICATE_WAIT_TIMEOUT = "timeout";

async function awaitRouteCertificate(input     ) {
  const relayPort = input.relayPort;
  const readRoute = input.readRoute;
  const startCertificate = typeof input.startCertificate === "function" ? input.startCertificate : null;
  const now = typeof input.now === "function" ? input.now : () => Date.now();
  const sleep = typeof input.sleep === "function"
    ? input.sleep
    : (ms     ) => new Promise((resolve     ) => setTimeout(resolve, ms));
  const pollMs = Number(input.pollMs) > 0 ? Number(input.pollMs) : DEFAULT_POLL_MS;
  const certificateWaitMs = Number(input.certificateWaitMs) > 0
    ? Number(input.certificateWaitMs)
    : DEFAULT_CERTIFICATE_WAIT_MS;
  const onProgress = typeof input.onProgress === "function" ? input.onProgress : () => {};
  let route      = input.route === undefined ? null : input.route;
  const started = now();
  const deadline = started + certificateWaitMs;
  let nextProgress = started + CERTIFICATE_PROGRESS_MS;
  let healthy = false;
  let issuance      = null;
  let certificateAskable = startCertificate !== null;
  let issued = false;
  let calls = 0;
  let lastStart      = null;
  let refused = false;
  try {
    for (;;) {
      if (issuance) {
        const outcome = issuance.poll();
        if (outcome !== null) {
          const ranMs = typeof issuance.ranMs === "function" ? issuance.ranMs() : null;
          issuance.stop();
          issuance = null;
          if (outcome === ISSUANCE_AVAILABLE) issued = true;

          else if (outcome === ISSUANCE_UNAVAILABLE) { refused = true; break; }

          else if (outcome === ISSUANCE_UNKNOWN && ranMs !== null && ranMs < CERTIFICATE_QUICK_FAIL_MS) certificateAskable = false;
        }
      }
      if (certificateAskable && !issued && !issuance && calls >= CERTIFICATE_MAX_CALLS) certificateAskable = false;
      if (certificateAskable && !issued && !issuance
        && (lastStart === null || now() - lastStart >= CERTIFICATE_RETRY_MS)) {
        lastStart = now();
        calls += 1;
        try {
          issuance = await startCertificate (Math.max(1000, deadline - lastStart));
        } catch (_) {
          issuance = null;
        }
        if (!issuance) certificateAskable = false;
      }
      if (issued || !certificateAskable) {
        route = await readRoute(relayPort);
        if (route && route.status === ROUTE_STATUS_HEALTHY) { healthy = true; break; }
      }
      if (now() >= deadline) break;
      if (now() >= nextProgress) {
        const periods = Math.floor((now() - started) / CERTIFICATE_PROGRESS_MS);
        onProgress((periods * CERTIFICATE_PROGRESS_MS) / 1000);
        nextProgress = started + (periods + 1) * CERTIFICATE_PROGRESS_MS;
      }
      await sleep(Math.max(0, Math.min(pollMs, deadline - now())));
    }
  } finally {
    if (issuance) issuance.stop();
  }
  const outcome = refused ? CERTIFICATE_WAIT_REFUSED : healthy ? CERTIFICATE_WAIT_HEALTHY : CERTIFICATE_WAIT_TIMEOUT;
  return { outcome, route };
}

function serveApplyArgv(relayPort     , port      = null, tailscaleArgv      = null) {
  const prefix = Array.isArray(tailscaleArgv) && tailscaleArgv.length > 0
    ? tailscaleArgv.slice()
    : ["tailscale"];
  return prefix.concat([
    "serve",
    "--bg",
    `--tls-terminated-tcp=${servePort(port)}`,
    `tcp://${LOOPBACK}:${relayPort}`,
  ]);
}

const CONVERSATION_ACCESS_DETAILS_HINT =
  "  Run again with --details to see the exact setting.";

const CODEX_REASONING_SUMMARY_MESSAGE =
  "Codex reasoning summaries turned on. Your glasses show them live once OpenClaw passes them on.";

function conversationAccessConsentLines(details      = false) {
  const lines = [
    "  OcuClaw needs to read and write the attached conversation",
    "  for glasses replies and voice input.",
    "  Other conversations and credentials are excluded.",
  ];
  if (details !== true) return lines.concat([CONVERSATION_ACCESS_DETAILS_HINT]);
  return lines.concat([
    "  This grant lets the OcuClaw plugin read and write the OpenClaw conversation",
    "  it is attached to: it can see the messages in that conversation and send its",
    "  own into it. That is what puts your replies on the glasses and your spoken",
    "  words into the conversation. It does not give the plugin your credentials and",
    "  it does not reach conversations you have not attached it to.",
    `  Change: ${CONVERSATION_ACCESS_CONFIG_PATH} = true`,
  ]);
}

function serveConsentLines(command     , details      = false, columns      = 0) {
  const lines = [
    "  Allow access from your tailnet only. Never public; never Tailscale Funnel.",
  ];
  if (details === true) {
    lines.push(
      "  This publishes the OcuClaw relay on your tailnet so your phone can reach it.",
      "  Tailnet only, never public, never Funnel: only devices signed in to your own",
      "  tailnet can connect, and nothing is exposed to the internet.",
    );
  }
  return lines.concat([
    "",
    "  If you say yes, setup will run:",
    ...wrapCommandLines(command, columns),
    `  Anything but ${CONSENT_ANSWER} leaves this route unchanged.`,
  ]);
}

function defaultConfirm(io     ) {
  const input = (io && io.input) || process.stdin;
  const output = (io && io.output) || process.stdout;

  return function confirm(lines     , strict      = false) {
    for (const line of lines) output.write(`${terminalText(line,
      line === CONVERSATION_ACCESS_DETAILS_HINT ? "detail" : "body", output, io.env)}\n`);
    const question = strict === true ? CONSENT_QUESTION_STRICT : CONSENT_QUESTION;
    return new Promise((resolve     ) => {
      let asked = 0;
      const askOnce = () => {
        asked += 1;
        output.write(terminalText(question, "action", output, io.env));
        let settled = false;

        const settle = (answer     , typed         ) => {
          if (settled) return;
          settled = true;
          try { input.removeListener("data", onData); input.removeListener("end", onEnd); } catch (_) {  }
          try { input.pause(); } catch (_) {  }
          output.write("\n");
          if (typed && String(answer).trim() === "" && asked < EMPTY_ANSWER_ASKS) {
            output.write(`${terminalText(`  ${EMPTY_ANSWER_MESSAGE}`, "body", output, io.env)}\n`);
            askOnce();
            return;
          }
          resolve(consentGiven(answer, strict));
        };
        const onData = (answer     ) => settle(answer, true);
        const onEnd = () => settle("", false);
        try {
          input.setEncoding("utf8");
          input.once("data", onData);
          input.once("end", onEnd);
          input.resume();
        } catch (_) {
          settle("", false);
        }
      };
      askOnce();
    });
  };
}

function defaultStartCertificate(layout     ) {
  return async function startCertificate(budgetMs     ) {
    const argv = cliArgv(layout);
    const node      = await readNodeState((args     ) => defaultRunTailscale(args, argv));
    if (!node || !node.dnsName) return null;
    return startCertificateIssuance(argv, node.dnsName, budgetMs);
  };
}

function defaultReadPhonePresence(layout     ) {
  return function phonePresence() {
    const argv = cliArgv(layout);
    return readPhonePresence((args     ) => defaultRunTailscale(args, argv));
  };
}

function defaultReadCertDomains(layout     ) {
  return function certDomains() {
    const argv = cliArgv(layout);
    return readCertDomains((args     ) => defaultRunTailscale(args, argv));
  };
}

function defaultWatchEnter(io     ) {
  const input = (io && io.input) || process.stdin;
  return function watchEnter(onPress     ) {

    const handler = (chunk     ) => { onPress(chunk); };
    try {
      input.setEncoding("utf8");
      input.on("data", handler);
      input.resume();
    } catch (_) {
      return () => {  };
    }
    return () => {
      try {
        if (typeof input.off === "function") input.off("data", handler);
        else if (typeof input.removeListener === "function") input.removeListener("data", handler);
        input.pause();
      } catch (_) {  }
    };
  };
}

function defaultIsTty(io     ) {
  const input = (io && io.input) || process.stdin;
  const output = (io && io.output) || process.stdout;
  return () => input.isTTY === true && output.isTTY === true;
}

function defaultGrantConversationAccess(api     ) {
  const runtimeConfig = api && api.runtime ? api.runtime.config : null;
  return async function grantConversationAccess() {
    if (
      !runtimeConfig ||
      typeof runtimeConfig.mutateConfigFile !== "function"
    ) {
      throw new Error(
        `this OpenClaw host does not expose the config mutation contract; set ${CONVERSATION_ACCESS_CONFIG_PATH} true yourself and run this command again`,
      );
    }

    let current      = null;
    try { current = typeof runtimeConfig.current === "function" ? runtimeConfig.current() : null; } catch (_) { current = null; }
    const codexConfigTomls = readCodexConfigTomlsSafely(api, current);
    let codexReasoningSummary      = null;
    await runtimeConfig.mutateConfigFile({
      afterWrite: { mode: "none", reason: "OcuClaw conversation access granted" },
      mutate(draft     ) {
        applyConversationAccessGrant(draft);
        try {
          codexReasoningSummary = applyCodexReasoningSummary(draft, { codexConfigTomls });
        } catch (_) {
          codexReasoningSummary = null;
        }
        return { granted: true };
      },
    });
    return {
      granted: true,
      codexReasoningSummary: codexReasoningSummary ? codexReasoningSummary.status : null,
    };
  };
}

function defaultReadRoute(api     , options     ) {
  const installation = setupInstallation(resolveSetupStateDir(api));
  return (relayPort     ) =>
    readPrivateRoute(relayPort, { installation, servePort: options && options.servePort });
}

function defaultPairingComplete(controller     ) {
  return async function pairingComplete() {
    if (typeof controller !== "function") return false;
    try {
      const journey      = await controller("journey", { surface: "cli" });
      const checkpoints = journey && Array.isArray(journey.checkpoints) ? journey.checkpoints : [];
      const checkpoint = checkpoints.find((entry     ) => entry && entry.id === "pair-phone");
      return !!checkpoint && checkpoint.status === "complete";
    } catch (_) {
      return false;
    }
  };
}

function defaultFirstUseCall(api     ) {
  return async function firstUseCall(params     ) {
    const installation = setupInstallation(resolveSetupStateDir(api));
    return setupFirstUseRequest({ ...params, installationId: installation.id });
  };
}

function firstUseFailureReason(error     ) {
  const message = error && error.message ? String(error.message) : String(error ?? "");
  const match = /\b(setup-[a-z-]+|installation-mismatch|runtime-unavailable)\b/.exec(message);
  return match ? match[1] : "unavailable";
}

function defaultRelayPort(api     , controller     ) {
  return async function relayPort() {
    if (typeof controller === "function") {
      try {
        const journey      = await controller("journey", { surface: "cli" });
        const live = journey && journey.currentHealth && journey.currentHealth.privateRoute
          ? journey.currentHealth.privateRoute.relay
          : null;
        if (live && Number.isInteger(live.port) && live.port > 0) return live.port;
      } catch (_) {  }
    }
    const runtime = api && api.runtime ? api.runtime : null;
    const env = runtime && runtime.process && runtime.process.env ? runtime.process.env : {};
    const overview = createRuntimeConfigOverview({
      env,
      pluginConfig: api ? api.pluginConfig : undefined,
      openclawConfig: api ? api.config : undefined,
    });
    return overview.wsPort;
  };
}

function defaultReadLoadedPlugin(controller     ) {
  return async function readLoadedPlugin() {
    if (typeof controller !== "function") return null;
    const journey      = await controller("journey", { surface: "cli" });
    const runtime = journey && isRecord(journey.runtimePlugin) ? journey.runtimePlugin : null;
    return runtime && typeof runtime.version === "string" && runtime.version
      ? { version: runtime.version }
      : null;
  };
}

async function readModelSignedIn(run      = defaultRunCommand) {
  try {
    const result      = await run(MODEL_STATUS_ARGV.slice(), { timeoutMs: 60000 });
    if (!result || result.code !== 0) return null;
    const text = String(result.stdout || "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return modelSignedIn(JSON.parse(text.slice(start, end + 1)));
  } catch (_) {
    return null;
  }
}

function defaultTerminalWindow(io     ) {
  const output = (io && io.output) || process.stdout;
  return () => ({
    tty: output.isTTY === true,
    columns: Number(output.columns) > 0 ? Number(output.columns) : 0,
    rows: Number(output.rows) > 0 ? Number(output.rows) : 0,
  });
}

const CLOUDWAYS_PHONE_ADDRESS_REFUSAL = Object.freeze([
  "This Cloudways host has a phone address set (phoneAddress).",
  "Cloudways reaches your phone only through its own Tailscale, so a phone address cannot work here.",
  "Remove it, then run this setup again:",
  "  openclaw config unset plugins.entries.ocuclaw.config.phoneAddress",
]);

async function runCloudwaysSetup(options      = {}, deps      = {}, io      = {}) {
  const output = io.output || process.stdout;
  const lines      = [];
  const steps      = [];

  const liveTty = output.isTTY === true;
  let live      = null;
  let liveIndex = -1;
  const endLive = () => {
    live = null;
  };
  const sayLive = (key     , line     , role      = "body") => {
    if (live === key) {
      if (!liveTty) return;
      lines[liveIndex] = line;
      output.write(`\u001b[1A\r\u001b[2K${terminalText(line, role, output, io.env)}\n`);
      return;
    }
    lines.push(line);
    liveIndex = lines.length - 1;
    live = key;
    output.write(`${terminalText(line, role, output, io.env)}\n`);
  };
  const say = (line     , role      = "body") => {
    endLive();
    lines.push(line);

    const indent = (String(line).match(/^ */) || [""])[0];
    const shown = indent ? String(line).replace(/\n(?=.)/g, `\n${indent}`) : line;
    output.write(`${terminalText(shown, role, output, io.env)}\n`);
  };
  const step = (index     , text     ) => {
    if (index > 1) say("");
    say(`[${index}/${SETUP_STEP_COUNT}] ${text}`, "heading");
  };
  const record = (id     , status     , detail      = null) => {
    steps.push({ id, status, detail });
  };

  const finish = (exitCode     , help      = exitCode === SETUP_EXIT_PROBLEM) => {
    if (help) say(`  ${STUCK_HELP_MESSAGE}`);
    endLive();
    return { exitCode, lines, steps };
  };

  const webTerminal = (io.env || process.env).OPENCLAW_TERMINAL === "1";

  const streamsIo      = {};
  for (const key of ["input", "output", "error"]) if (io[key]) streamsIo[key] = io[key];

  const pairIo = { driven: true, ...streamsIo, ...(io.env ? { env: io.env } : {}) };

  const api = deps.api || null;
  const layout = deps.layout || resolveLayout(options);
  const verbDeps = isRecord(deps.verbDeps) ? { ...deps.verbDeps, layout } : { layout };
  const runVerb = typeof deps.runVerb === "function" ? deps.runVerb : runCloudwaysVerb;
  const isTty = typeof deps.isTty === "function" ? deps.isTty : defaultIsTty(io);
  const confirm = typeof deps.confirm === "function" ? deps.confirm : defaultConfirm(io);
  const sleep = typeof deps.sleep === "function"
    ? deps.sleep
    : (ms     ) => new Promise((resolve     ) => setTimeout(resolve, ms));
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const readConfig = typeof deps.readConfig === "function"
    ? deps.readConfig
    : () => (api && api.runtime && api.runtime.config && typeof api.runtime.config.current === "function"
      ? api.runtime.config.current()
      : null);
  const grantConversationAccess = typeof deps.grantConversationAccess === "function"
    ? deps.grantConversationAccess
    : defaultGrantConversationAccess(api);

  const codexReasoningSummaryOwed = typeof deps.codexReasoningSummaryOwed === "function"
    ? deps.codexReasoningSummaryOwed
    : (config     ) => {
      if (!api) return false;
      try {
        return planCodexReasoningSummary(config, {
          codexConfigTomls: readCodexConfigTomlsSafely(api, config),
        }).status === "write";
      } catch (_) {
        return false;
      }
    };
  const provisionRelayCredential = typeof deps.provisionRelayCredential === "function"
    ? deps.provisionRelayCredential
    : createRelayCredentialProvision(api);
  const readRoute = typeof deps.readRoute === "function" ? deps.readRoute : defaultReadRoute(api, options);
  const runServeApply = typeof deps.runServeApply === "function"
    ? deps.runServeApply
    : (argv     ) => defaultRunCommand(argv, { timeoutMs: 30000 });

  const startCertificate = typeof deps.startCertificate === "function"
    ? deps.startCertificate
    : (typeof deps.readRoute === "function" ? null : defaultStartCertificate(layout));

  const readHttps = typeof deps.readCertDomains === "function"
    ? deps.readCertDomains
    : (typeof deps.readRoute === "function" ? null : defaultReadCertDomains(layout));
  const queryEnableLink = typeof deps.queryEnableLink === "function"
    ? deps.queryEnableLink
    : () => queryHttpsEnableLink(layout.socketPath);
  const pair = typeof deps.pair === "function" ? deps.pair : null;
  const pairingComplete = typeof deps.pairingComplete === "function"
    ? deps.pairingComplete
    : defaultPairingComplete(deps.controller);

  const firstUse = typeof deps.firstUse === "function"
    ? deps.firstUse
    : (api ? createFirstUseCommand(api) : null);
  const firstUseCall = typeof deps.firstUseCall === "function"
    ? deps.firstUseCall
    : (api ? defaultFirstUseCall(api) : null);

  const welcome = typeof deps.welcome === "function" ? deps.welcome : (api ? runSetupWelcome : null);
  const phonePresence = typeof deps.readPhonePresence === "function"
    ? deps.readPhonePresence
    : defaultReadPhonePresence(layout);
  const watchEnter = typeof deps.watchEnter === "function" ? deps.watchEnter : defaultWatchEnter(io);

  const watchAnswer = typeof deps.watchAnswer === "function" ? deps.watchAnswer : watchEnter;
  const phoneWaitS = Number(deps.phoneWaitS) > 0 ? Number(deps.phoneWaitS) : DEFAULT_PHONE_WAIT_S;
  const phonePollMs = Number(deps.phonePollMs) > 0 ? Number(deps.phonePollMs) : DEFAULT_PHONE_POLL_MS;
  const pollMs = Number(deps.pollMs) > 0 ? Number(deps.pollMs) : DEFAULT_POLL_MS;
  const noticeMs = Number(deps.noticeMs) > 0 ? Number(deps.noticeMs) : DEFAULT_NOTICE_MS;
  const answerWaitMs = Number(deps.answerWaitMs) > 0 ? Number(deps.answerWaitMs) : ANSWER_WAIT_MS;
  const certificateWaitMs = Number(deps.certificateWaitMs) > 0
    ? Number(deps.certificateWaitMs)
    : DEFAULT_CERTIFICATE_WAIT_MS;

  const installedVersion = typeof deps.installedVersion === "string"
    ? deps.installedVersion
    : (typeof PLUGIN_VERSION === "string" ? PLUGIN_VERSION : "");
  const readLoadedPlugin = typeof deps.readLoadedPlugin === "function"
    ? deps.readLoadedPlugin
    : defaultReadLoadedPlugin(deps.controller);

  const readGatewayRunning = typeof deps.gatewayRunning === "function"
    ? deps.gatewayRunning
    : () => gatewayProcessRunning();

  const readModelStatus = typeof deps.readModelStatus === "function" ? deps.readModelStatus : () => readModelSignedIn();

  const terminalWindow = typeof deps.terminalWindow === "function" ? deps.terminalWindow : defaultTerminalWindow(io);
  const terminalColumns = () => {
    const window = terminalWindow();
    return window && window.tty === true && Number(window.columns) > 0 ? Number(window.columns) : 0;
  };

  let configuredForCustomRoute = false;
  try { configuredForCustomRoute = configuredPhoneAddress({ runtime: { config: { current: readConfig } } }) !== null; }
  catch (_) { configuredForCustomRoute = false; }
  if (configuredForCustomRoute) {
    for (const line of CLOUDWAYS_PHONE_ADDRESS_REFUSAL) say(line);
    return finish(SETUP_EXIT_STOPPED, false);
  }

  const assumeYes = options.yes === true;

  const details = options.details === true;
  const skipPair = options.pair === false || options.noPair === true;
  const enrollWaitS = Number(options.wait) > 0 ? Number(options.wait) : DEFAULT_ENROLL_WAIT_S;
  const firstUseWaitS = Number(options.firstUseWait) > 0
    ? Number(options.firstUseWait)
    : DEFAULT_FIRST_USE_WAIT_S;

  const ask = async (consentLines     , strict      = false) => {
    if (assumeYes) {
      for (const line of consentLines) say(line);
      say(`  Approved by --yes.`, "detail");
      return true;
    }
    endLive();
    for (const line of consentLines) lines.push(line);
    return (await confirm(consentLines, strict)) === true;
  };

  const awaitTypedLine = (timeoutMs      = answerWaitMs) => {
    const armedAt = now();
    let cancel      = null;
    let answered = false;
    let timer      = null;
    const typed = new Promise((resolve     ) => {

      timer = setTimeout(() => { if (!answered) { answered = true; resolve(null); } }, timeoutMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      cancel = watchAnswer((chunk     ) => {
        if (answered) return;
        if (now() - armedAt < ENTER_SETTLE_MS) return;
        answered = true;
        resolve(typeof chunk === "string" ? chunk : "");
      });
    });
    return typed.then((chunk     ) => {
      if (timer) clearTimeout(timer);
      if (typeof cancel === "function") cancel();
      return chunk;
    });
  };

  const checkModelSignIn = async () => {
    say(`  ${PROGRESS_SIGN_IN_MESSAGE}`, "detail");
    let signedIn      = null;
    try { signedIn = await readModelStatus(); } catch (_) { signedIn = null; }
    if (signedIn !== false) {
      record("model-sign-in", "skipped", signedIn === true ? "signed in" : "unreadable");
      return false;
    }
    for (const line of modelPanelSignInLines()) say(line);
    record("model-sign-in", "refused", "no model signed in");
    return true;
  };

  say(DROPPED_TERMINAL_MESSAGE, "detail");
  say("");
  step(1, "Cloudways host");
  let detected     ;
  try {
    detected = await runVerb("detect", {}, verbDeps);
  } catch (err     ) {
    say(`  Could not read this host: ${err && err.message ? err.message : err}`);
    record("detect", "failed", "detect threw");
    return finish(SETUP_EXIT_PROBLEM);
  }
  if (!detected || !detected.report || detected.report.verdict !== DETECT_CLOUDWAYS) {
    say(`  ${NOT_CLOUDWAYS_MESSAGE}`);
    record("detect", "refused", detected && detected.report ? detected.report.verdict : "unknown");
    return finish(SETUP_EXIT_PROBLEM);
  }
  say(`  ${detected.report.hostname} is a Cloudways Managed AI Agents container.`);
  record("detect", "done", detected.report.hostname);

  if (!assumeYes && !isTty()) {
    say(TTY_REQUIRED_MESSAGE);
    record("tty", "refused", "no terminal");
    return finish(SETUP_EXIT_PROBLEM);
  }
  if (await checkModelSignIn()) return finish(SETUP_EXIT_STOPPED, false);

  step(2, "Conversation access");
  const step2Config = readConfig();
  if (conversationAccessGranted(step2Config)) {
    say("  Settings already applied.");
    if (details) for (const line of conversationAccessConsentLines(true)) say(line);
    record("conversation-access", "skipped", "already granted");
    if (codexReasoningSummaryOwed(step2Config)) {

      try {
        const grant = await grantConversationAccess();
        if (grant && grant.codexReasoningSummary === "set") say(`  ${CODEX_REASONING_SUMMARY_MESSAGE}`);
      } catch (_) {  }
    }
  } else {
    if (details) for (const line of conversationAccessConsentLines(true)) say(line);
    let grant     ;
    try {
      grant = await grantConversationAccess();
    } catch (err     ) {
      say(`  Could not record the grant: ${err && err.message ? err.message : err}`);
      record("conversation-access", "failed", "write refused");
      return finish(SETUP_EXIT_PROBLEM);
    }
    say("  Conversation access granted.");
    if (grant && grant.codexReasoningSummary === "set") say(`  ${CODEX_REASONING_SUMMARY_MESSAGE}`);
    record("conversation-access", "done", null);
  }

  step(3, "OcuClaw");
  say(`  ${PROGRESS_LOADED_MESSAGE}`, "detail");
  let credential     ;
  try {
    credential = await provisionRelayCredential({ operation: PROVISION_RELAY_CREDENTIAL_OPERATION });
  } catch (err     ) {
    say(`  ${OCUCLAW_NOT_LOADED_MESSAGE}`);
    for (const line of OCUCLAW_NOT_LOADED_HELP_LINES) say(line);
    record("relay-credential", "failed", err && err.code ? err.code : "error");
    return finish(SETUP_EXIT_PROBLEM);
  }
  record("relay-credential",
    credential && credential.status === "preserved" ? "skipped" : "done",
    credential && credential.status === "preserved" ? "preserved" : "provisioned");

  let loaded      = null;
  const loadedStarted = now();
  const loadedDeadline = loadedStarted + LOADED_CHECK_WAIT_MS;
  let loadedProgressAt = loadedStarted + LOADED_PROGRESS_EVERY_MS;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      if (now() + LOADED_CHECK_RETRY_MS > loadedDeadline) break;
      await sleep(LOADED_CHECK_RETRY_MS);
    }
    try { loaded = await readLoadedPlugin(); } catch (_) { loaded = null; }
    if (loaded && typeof loaded.version === "string" && loaded.version) break;
    loaded = null;
    if (attempt === 0) say(`  ${PROGRESS_LOADED_WAIT_MESSAGE}`, "detail");
    else if (now() >= loadedProgressAt) {
      say(`  ${loadedProgressMessage((now() - loadedStarted) / 1000)}`, "detail");
      loadedProgressAt += LOADED_PROGRESS_EVERY_MS;
    }
  }
  const loadedVersion = loaded ? loaded.version : null;
  if (loadedVersion === null || (installedVersion && loadedVersion !== installedVersion)) {
    say(loadedVersion === null
      ? `  ${OCUCLAW_NOT_LOADED_MESSAGE}`
      : `  ${ocuclawOldVersionMessage(loadedVersion, installedVersion)}`);

    let gatewayRunning      = null;
    try { gatewayRunning = await readGatewayRunning(); } catch (_) { gatewayRunning = null; }
    let phonePaired = false;
    try { phonePaired = (await pairingComplete()) === true; } catch (_) { phonePaired = false; }
    for (const line of ocuclawRestartLines({ gatewayRunning, phonePaired, webTerminal })) {
      say(line, line.startsWith("    ") ? "action" : "body");
    }
    record("plugin-loaded", "failed", loadedVersion === null ? "not loaded" : "version mismatch");
    if (gatewayRunning === false) record("gateway-process", "failed", "not running");
    return finish(SETUP_EXIT_STOPPED);
  }
  say(`  ${OCUCLAW_LOADED_MESSAGE}`);
  record("plugin-loaded", "done", loadedVersion);

  step(4, "Tailscale");
  say(`  ${PROGRESS_TAILSCALE_MESSAGE}`, "detail");
  let state = await runVerb("status", {}, verbDeps);
  let report = state.report || {};
  const movePending = !!(report.binaries && report.binaries.movePending);
  const installed = !!(report.binaries && report.binaries.present) && !!report.receipt && !movePending;
  if (movePending) say(`  ${TAILSCALE_MOVE_MESSAGE}`);
  if (installed) {
    say("  Tailscale is already installed.");
    record("install", "skipped", "installed");
  } else {
    if (!movePending) say(`  ${PROGRESS_TAILSCALE_INSTALL_MESSAGE}`, "detail");
    const installResult = await runVerb("install", {}, verbDeps);
    if (!installResult.report || installResult.report.ok !== true) {
      for (const line of installResult.lines || []) say(`  ${line}`);
      record("install", "failed", installResult.report ? installResult.report.error : "install failed");
      return finish(SETUP_EXIT_PROBLEM);
    }

    say("  Tailscale is ready.");
    record("install", "done", installResult.report.version || null);
    state = await runVerb("status", {}, verbDeps);
    report = state.report || {};
  }
  let daemonState = report.daemon ? report.daemon.state : null;
  if (daemonState !== STATE_RUNNING && daemonState !== STATE_NEEDS_AUTH) {
    const enabled = await runVerb("enable", {}, verbDeps);
    if (!enabled.report || enabled.report.ok !== true) {
      for (const line of enabled.lines || []) say(`  ${line}`);
      record("daemon", "failed", enabled.report ? enabled.report.error : "daemon refused");
      return finish(SETUP_EXIT_PROBLEM);
    }
    say("  Tailscale started.");
    record("daemon", "done", null);
    state = await runVerb("status", {}, verbDeps);
    report = state.report || {};
    daemonState = report.daemon ? report.daemon.state : null;
  } else if (daemonState === STATE_RUNNING) {
    say("  Tailscale is running.");
    record("daemon", "skipped", daemonState);
  } else {
    say("  Tailscale is running. Server approval is still needed.");
    record("daemon", "skipped", daemonState);
  }

  step(5, "Connect to Tailscale");
  if (daemonState === STATE_RUNNING) {
    say("  This server is already approved.");
    record("enroll", "skipped", STATE_RUNNING);
  } else {
    say(`  ${PROGRESS_ENROLL_MESSAGE}`, "detail");
    const enrolled = await runVerb(
      "enroll",
      { hostname: options.hostname || null, wait: 90 },
      verbDeps,
    );
    const enrollReport = enrolled.report || {};

    if (enrollReport.staleMarkerCleared === true) say(`  ${STALE_ENROLLMENT_MESSAGE}`);
    if (enrollReport.state === STATE_RUNNING) {
      say("  This server is already approved.");
      record("enroll", "skipped", STATE_RUNNING);
    } else if (!enrollReport.authUrl) {
      for (const line of enrolled.lines || []) say(`  ${line}`);
      record("enroll", "failed", enrollReport.error || "no authorization link");
      return finish(SETUP_EXIT_PROBLEM);
    } else {
      if (webTerminal) {

        say(ENROLL_WEB_LINK_LINE, "action");
        say(`    ${enrollReport.authUrl}`);
        for (const line of ENROLL_WEB_ACCOUNT_LINES) say(line);
      } else {

        say(ENROLL_INSTALL_TAILSCALE_LINE);
        for (const line of ENROLL_ON_PHONE_LINES) say(line, "action");
        say(`    ${enrollReport.authUrl}`);
      }
      const deadline = now() + enrollWaitS * 1000;
      let lastNotice = now();
      let running = false;
      let approvedDaemon      = null;
      for (;;) {
        const polled = await runVerb("status", {}, verbDeps);
        const polledState = polled.report && polled.report.daemon ? polled.report.daemon.state : null;
        if (polledState === STATE_RUNNING) { running = true; approvedDaemon = polled.report.daemon; break; }
        if (now() >= deadline) break;
        if (now() - lastNotice >= noticeMs) {
          lastNotice = now();
          say("  Waiting for server approval.");
        }
        await sleep(pollMs);
      }
      if (!running) {
        say("  Server approval timed out. Run setup again to resume.");
        record("enroll", "failed", "timeout");
        return finish(SETUP_EXIT_PROBLEM);
      }
      say("  Server approved.");
      const suffix = tailnetNameSuffix(approvedDaemon);
      if (suffix) say(tailnetSuffixLine(suffix));
      record("enroll", "done", null);
    }
  }

  step(6, "Private route for your phone");
  say(`  ${PROGRESS_ROUTE_MESSAGE}`, "detail");
  const relayPort = deps.relayPort !== undefined && deps.relayPort !== null
    ? deps.relayPort
    : await defaultRelayPort(api, deps.controller)();
  let route = await readRoute(relayPort);

  if (route && ROUTE_NOT_OURS_STATUSES.includes(route.status)) {
    say(`  ${ROUTE_NOT_OURS_MESSAGE}`);
    record("serve", "refused", route.status);
    return finish(SETUP_EXIT_PROBLEM);
  }
  if (route && route.status === ROUTE_STATUS_HEALTHY) {
    say("  Private route is already configured.");
    record("serve", "skipped", ROUTE_STATUS_HEALTHY);
  } else {

    const httpsState = async () => {
      try { return await readHttps(); } catch (_) { return CERT_DOMAINS_UNKNOWN; }
    };
    if (readHttps && (await httpsState()) === CERT_DOMAINS_UNAVAILABLE) {
      let link      = null;
      try { link = await queryEnableLink(); } catch (_) { link = null; }
      if (typeof link !== "string" || !link) link = null;
      say(`  ${HTTPS_OFF_MESSAGE}`);
      say(`  ${link ? HTTPS_ENABLE_LINK_LINE : HTTPS_ADMIN_PAGE_LINE}`, "action");
      say(`    ${link || HTTPS_ADMIN_PAGE_URL}`);
      say(`  ${HTTPS_CARRIES_ON_MESSAGE}`);

      const deadline = now() + DEFAULT_HTTPS_WAIT_MS;
      let lastNotice = now();
      let on = false;
      while (now() < deadline) {
        if (now() - lastNotice >= noticeMs) {
          lastNotice = now();
          say(`  ${HTTPS_WAITING_MESSAGE}`);
        }
        await sleep(Math.min(pollMs, deadline - now()));
        if ((await httpsState()) === CERT_DOMAINS_AVAILABLE) { on = true; break; }
      }
      if (!on) {
        say(`  ${HTTPS_TIMEOUT_MESSAGE}`);
        record("serve", "failed", "https-off");
        return finish(SETUP_EXIT_PROBLEM);
      }
      say(`  ${HTTPS_ON_MESSAGE}`);
    }
    const port = servePort(options.servePort);
    const tailscaleArgv = cliArgv(layout);
    const command = applyCommand(relayPort, port, tailscaleArgv);

    const approved = await ask(serveConsentLines(command, details, terminalColumns()), true);
    if (!approved) {
      say(RESUME_MESSAGE);
      record("serve", "declined", null);
      return finish(SETUP_EXIT_STOPPED);
    }
    const applied = await runServeApply(serveApplyArgv(relayPort, port, tailscaleArgv));
    if (!applied || applied.code !== 0) {
      const detail = applied && applied.stderr ? String(applied.stderr).trim() : "no output";
      say(`  The route could not be published: ${detail}`);
      record("serve", "failed", detail);
      return finish(SETUP_EXIT_PROBLEM);
    }
    say("  Private route configured.");

    say(`  ${COLD_CERTIFICATE_MESSAGE}`);

    const waited = await awaitRouteCertificate({
      relayPort, route, readRoute, startCertificate, now, sleep, pollMs, certificateWaitMs,
      onProgress: (elapsedS     ) => say(`  ${certificateProgressMessage(elapsedS)}`),
    });
    route = waited.route;
    if (waited.outcome === CERTIFICATE_WAIT_REFUSED) {
      say(`  ${CERTIFICATE_REFUSED_MESSAGE}`);
      record("serve", "failed", "certificate-unavailable");
      return finish(SETUP_EXIT_PROBLEM);
    }
    if (waited.outcome !== CERTIFICATE_WAIT_HEALTHY) {
      say(`  ${CERTIFICATE_TIMEOUT_MESSAGE}`);
      record("serve", "failed", route ? route.status : "unknown");
      return finish(SETUP_EXIT_PROBLEM);
    }
    say("  Certificate ready.");
    record("serve", "done", null);
  }

  const awaitPhoneOnTailnet = async () => {
    const look = async () => {
      let answer      = null;
      try {
        answer = await phonePresence();
      } catch (_) {
        return { found: false, readable: false };
      }
      const found = !!(answer && answer.found === true);
      return { found, readable: found || !!(answer && answer.readable === true) };
    };

    const first = await look();
    if (first.found) {
      say(`  ${PHONE_PRESENT_MESSAGE}`);
      record("phone-check", "done", "present");
      return { stopped: false, found: true };
    }
    if (!first.readable) {

      record("phone-check", "skipped", "unreadable");
      return { stopped: false, found: false };
    }

    if (!isTty()) {
      say(`  ${PHONE_NO_TERMINAL_MESSAGE}`);
      record("phone-check", "skipped", "no terminal");
      return { stopped: false, found: false };
    }

    for (const line of PHONE_WALKTHROUGH_LINES) say(line, line.startsWith("Waiting") ? "action" : "body");
    let carriedOn = false;

    const armedAt = now();
    const cancelEnter = watchEnter(() => {
      if (now() - armedAt >= ENTER_SETTLE_MS) carriedOn = true;
    });
    let appeared = false;
    try {
      const deadline = now() + phoneWaitS * 1000;
      while (!carriedOn) {
        if (now() >= deadline) break;
        await sleep(phonePollMs);
        if (carriedOn) break;
        const again = await look();
        if (again.found) { appeared = true; break; }

      }
    } finally {
      if (typeof cancelEnter === "function") cancelEnter();
    }
    if (appeared) {
      say(`  ${PHONE_APPEARED_MESSAGE}`);
      record("phone-check", "done", "appeared");
      return { stopped: false, found: true };
    }
    if (carriedOn) {
      say(`  ${PHONE_CARRY_ON_MESSAGE}`);
      record("phone-check", "skipped", "carried on");
      return { stopped: false, found: false };
    }
    say(`  ${PHONE_WAIT_TIMEOUT_MESSAGE}`);

    record("phone-check", "declined", "timeout");
    return { stopped: true, found: false };
  };

  step(7, "Pair your phone");
  say(`  ${PROGRESS_PHONE_MESSAGE}`, "detail");
  let phonePaired = false;
  if (await pairingComplete()) {
    say("  A phone is already paired.");
    record("pair", "skipped", "already paired");
    phonePaired = true;
  } else if (skipPair) {
    say("  Pairing skipped (--no-pair).\nWhen ready, run openclaw ocuclaw pair.");
    record("pair", "skipped", "--no-pair");
  } else if (typeof pair !== "function") {
    say("  This host cannot run the terminal pairing ceremony. Run openclaw ocuclaw pair yourself.");
    record("pair", "failed", "pairing unavailable");
    return finish(SETUP_EXIT_PROBLEM);
  } else {
    const phoneCheck = await awaitPhoneOnTailnet();
    if (phoneCheck.stopped) {
      record("pair", "skipped", "no phone on the tailnet");
      return finish(SETUP_EXIT_STOPPED);
    }

    say(PAIR_OPEN_APP_MESSAGE, "action");

    const interactive = !assumeYes && isTty();
    let attempts = 0;
    for (;;) {
      const ceremonyIo = interactive && attempts === 0 ? { ...pairIo, readyLines: PAIR_READY_LINES } : pairIo;
      const paired = await pair({ lightTerminal: options.lightTerminal === true }, ceremonyIo);
      attempts += 1;
      const exitCode = paired && Number.isInteger(paired.exitCode) ? paired.exitCode : SETUP_EXIT_PROBLEM;
      const outcome = paired ? paired.outcome || null : null;
      if (exitCode === SETUP_EXIT_OK) {
        record("pair", "done", outcome);
        phonePaired = true;
        break;
      }

      if (outcome !== "expired") {
        record("pair", "failed", outcome);
        const decided = outcome === "refused" || outcome === "cancelled";
        return finish(exitCode, !decided && exitCode === SETUP_EXIT_PROBLEM);
      }
      say(`  ${pairingExpiryMessage(paired?.phase, paired?.failureReason)}`);

      if (paired?.phase === "waiting-for-phone") {
        for (const line of PAIR_TIMEOUT_CAUSE_LINES) say(`  ${line}`);
        say(`  ${PAIR_SCREEN_NOT_OPEN_MESSAGE}`);
      }

      if (!interactive || attempts > PAIR_RETRY_LIMIT) {
        record("pair", "failed", outcome);
        return finish(exitCode);
      }
      say(PAIR_RETRY_PROMPT_MESSAGE, "action");
      const typed = await awaitTypedLine();

      if (typed === null) {
        say(`  ${PAIR_RETRY_NO_ANSWER_MESSAGE}`);
        record("pair", "failed", "no answer");
        return finish(exitCode);
      }
      const answer = String(typed).trim().toLowerCase();
      if (answer === PAIR_RETRY_STOP_ANSWER) {
        record("pair", "failed", outcome);

        return finish(exitCode, false);
      }
    }
  }

  step(8, "First message");
  if (!phonePaired || options.firstUse === false) {
    say(`  ${FIRST_USE_SKIPPED_MESSAGE}`);
    record("first-use", "skipped", options.firstUse === false ? "--no-first-use" : "--no-pair");
    return finish(SETUP_EXIT_OK);
  }
  if (typeof firstUse !== "function" || typeof firstUseCall !== "function") {
    say(`  ${FIRST_USE_UNAVAILABLE_MESSAGE}`);
    record("first-use", "failed", "first-use unavailable");
    return finish(SETUP_EXIT_PROBLEM);
  }

  const rider = createGatewayFreezeRider({ now, sleep, say: (text     ) => say(`  ${text}`) });
  let lostGateway      = null;
  const callFirstUse = async (params     ) => {
    try { return { ok: true, record: recordOf(await rider.call(() => firstUseCall(params))) }; }
    catch (err     ) {
      if (isGatewayUnresponsive(err)) { lostGateway = err; return { ok: false, reason: GATEWAY_UNRESPONSIVE_REASON }; }
      return { ok: false, reason: firstUseFailureReason(err) };
    }
  };
  const gatewayLost = () => {
    for (const line of gatewayUnresponsiveMessage(lostGateway?.waitedMs).split("\n")) say(`  ${line}`, "action");
    record("first-use", "failed", GATEWAY_UNRESPONSIVE_REASON);
    return finish(SETUP_EXIT_PROBLEM);
  };

  const current = await callFirstUse({ operation: "first_use_wait" });
  if (current.reason === GATEWAY_UNRESPONSIVE_REASON) return gatewayLost();
  if (current.ok && current.record && current.record.status === "completed") {
    say(`  ${FIRST_USE_ALREADY_COMPLETE_VALUE}`);
    record("first-use", "skipped", "already complete");
    return finish(SETUP_EXIT_OK);
  }

  const armed = await callFirstUse({ operation: "begin" });
  if (armed.reason === GATEWAY_UNRESPONSIVE_REASON) return gatewayLost();
  if (!armed.ok || !armed.record) {
    say(`  Could not start the first-message check. ${firstUseStopSentence(armed.reason || "unavailable")}`);
    say(`  ${FIRST_USE_RECOVERY_LINE}`, "action");
    say(`  Code: ${armed.reason || "unavailable"}`, "detail");
    record("first-use", "failed", armed.reason || "unavailable");
    return finish(SETUP_EXIT_PROBLEM);
  }

  if (armed.record.status === "awaiting-reply") {
    say(`  In the paired conversation on your phone, send ${FIRST_USE_SEND_TEXT_VALUE}.`, "action");
    say("  Waiting for the reply on your glasses...");
  }

  const waited = await awaitFirstUseReply({
    call: callFirstUse,
    say: (text     , kind      = null) => say(`  ${text}`, kind),

    waiting: (elapsedMs     ) => sayLive("first-use-wait", `  ${firstUseWaitingProgress(elapsedMs / 1000)}`),
    now, sleep,
    waitMs: firstUseWaitS * 1000,
    pollMs, noticeMs,
    phoneSettleMs: FIRST_USE_PHONE_SETTLE_MS,
    initialStatus: armed.record.status,
  });
  if (waited.outcome === "unavailable" && waited.reason === GATEWAY_UNRESPONSIVE_REASON) return gatewayLost();
  if (waited.outcome === "unavailable") {
    const reason = waited.reason || "unavailable";
    say(`  Could not check the first message. ${firstUseStopSentence(reason)}`);
    say(`  ${FIRST_USE_RECOVERY_LINE}`, "action");
    say(`  Code: ${reason}`, "detail");
    record("first-use", "failed", reason);
    return finish(SETUP_EXIT_PROBLEM);
  }
  if (waited.outcome === "timeout" || waited.outcome === "cancelled") {
    say(`  ${FIRST_USE_TIMEOUT_MESSAGE}`);
    record("first-use", "failed", "timeout");
    return finish(SETUP_EXIT_PROBLEM);
  }

  if (waited.outcome === "errored") {
    const replyReason = waited.reason;
    say(`  ${replyReason === "reply_run_rate_limited" ? FIRST_USE_REPLY_RATE_LIMIT_MESSAGE : FIRST_USE_REPLY_ERROR_MESSAGE}`);
    record("first-use", "failed", replyReason);
    return finish(SETUP_EXIT_PROBLEM);
  }
  say(`  ${FIRST_USE_REPLY_VALUE}`);

  const ceremonyIo = io.input && io.input.speckLook === true ? streamsIo : undefined;

  const ceremony = await firstUse(options.testInput === true
    ? { testInput: true, waitForReply: false }
    : { waitForReply: false }, ceremonyIo);
  const ceremonyExit = ceremony && Number.isInteger(ceremony.exitCode)
    ? ceremony.exitCode
    : SETUP_EXIT_PROBLEM;
  if (ceremonyExit !== SETUP_EXIT_OK && ceremony && ceremony.gatewayUnresponsive === true) {

    record("first-use", "failed", GATEWAY_UNRESPONSIVE_REASON);
    return finish(SETUP_EXIT_PROBLEM);
  }
  if (ceremonyExit !== SETUP_EXIT_OK) {
    say(`  ${FIRST_USE_PENDING_MESSAGE}`);
    record("first-use", "failed", "not confirmed");
    return finish(ceremonyExit);
  }
  if (ceremony && ceremony.testInput === true) {
    say(`  ${FIRST_USE_TEST_INPUT_MESSAGE}`);
    record("first-use", "skipped", "test-input");
    return finish(SETUP_EXIT_OK);
  }
  const settled = await callFirstUse({ operation: "first_use_wait" });

  if (settled.reason === GATEWAY_UNRESPONSIVE_REASON) return gatewayLost();
  const settledStatus = settled.ok && settled.record ? settled.record.status : null;
  if (settledStatus === "awaiting-welcome") {
    if (typeof welcome !== "function") {
      say(`  ${FIRST_USE_WELCOME_UNAVAILABLE_MESSAGE}`);
      record("first-use", "done", "awaiting-welcome");
      return finish(SETUP_EXIT_OK);
    }

    const mirror = { write: (chunk     ) => {
      for (const line of String(chunk).split("\n")) if (line) lines.push(line);
      return output.write(chunk);
    } };
    const nextOperations = Array.isArray(settled.record.nextOperations) ? settled.record.nextOperations : [];
    const shown      = await welcome(api, {
      binding: settled.record.binding,
      retry: nextOperations.includes("first_use_welcome_retry"),
    }, { output: mirror, now, sleep });
    if (!shown || shown.ok !== true) {
      const outcome = (shown && shown.outcome) || "unavailable";

      if (outcome === "unavailable") {
        record("first-use", "done", "awaiting-welcome");
        return finish(SETUP_EXIT_OK);
      }
      record("first-use", "failed", outcome);
      return finish(SETUP_EXIT_PROBLEM);
    }
    record("first-use", "done", "welcome-dismissed");
    return finish(SETUP_EXIT_OK);
  }

  if (settledStatus !== "completed") say(SETUP_COMPLETE_MESSAGE);
  record("first-use", "done", settledStatus || "completed");
  return finish(SETUP_EXIT_OK);
}

function recordOf(result     ) {
  return result && isRecord(result.record) ? result.record : null;
}

module.exports = { SETUP_STEP_COUNT, SETUP_EXIT_OK, SETUP_EXIT_PROBLEM, SETUP_EXIT_STOPPED, CONSENT_ANSWER, CONSENT_QUESTION, CONSENT_ANSWERS, CONSENT_QUESTION_STRICT, consentGiven, EMPTY_ANSWER_ASKS, EMPTY_ANSWER_MESSAGE, CONVERSATION_ACCESS_CONFIG_PATH, conversationAccessGranted, NOT_CLOUDWAYS_MESSAGE, TTY_REQUIRED_MESSAGE, RESUME_MESSAGE, DROPPED_TERMINAL_MESSAGE, COLD_CERTIFICATE_MESSAGE, certificateProgressMessage, waitedFor, PROGRESS_SIGN_IN_MESSAGE, PROGRESS_LOADED_MESSAGE, PROGRESS_TAILSCALE_MESSAGE, PROGRESS_TAILSCALE_INSTALL_MESSAGE, TAILSCALE_MOVE_MESSAGE, PROGRESS_ENROLL_MESSAGE, PROGRESS_ROUTE_MESSAGE, PROGRESS_PHONE_MESSAGE, firstUseWaitingProgress, wrapCommandLines, CERTIFICATE_TIMEOUT_MESSAGE, CERTIFICATE_REFUSED_MESSAGE, HTTPS_OFF_MESSAGE, HTTPS_ENABLE_LINK_LINE, HTTPS_ADMIN_PAGE_LINE, HTTPS_ADMIN_PAGE_URL, HTTPS_CARRIES_ON_MESSAGE, HTTPS_WAITING_MESSAGE, HTTPS_ON_MESSAGE, HTTPS_TIMEOUT_MESSAGE, PAIR_RETRY_NO_ANSWER_MESSAGE, ROUTE_NOT_OURS_STATUSES, ROUTE_NOT_OURS_MESSAGE, STUCK_HELP_MESSAGE, OCUCLAW_LOADED_MESSAGE, OCUCLAW_NOT_LOADED_MESSAGE, ocuclawOldVersionMessage, CLOUDWAYS_RESTART_COMMAND, CLOUDWAYS_RESTART_WARNING_LINES, SETUP_COMMAND, OCUCLAW_NOT_LOADED_HELP_LINES, OCUCLAW_RESTART_LINES, CLOUDWAYS_DASHBOARD_RESTART_MESSAGE, OCUCLAW_DASHBOARD_RESTART_LINES, WEB_TERMINAL_RESTART_LINE, OCUCLAW_WEB_TERMINAL_RESTART_LINES, OCUCLAW_WEB_TERMINAL_DASHBOARD_RESTART_LINES, ocuclawRestartLines, LOADED_CHECK_WAIT_MS, PROGRESS_LOADED_WAIT_MESSAGE, LOADED_PROGRESS_EVERY_MS, loadedProgressMessage, MODEL_STATUS_ARGV, MODEL_PANEL_PATH, MODEL_PANEL_SIGN_IN_LINES, modelPanelSignInLines, modelSignedIn, ENROLL_ON_PHONE_LINES, ENROLL_INSTALL_TAILSCALE_LINE, ENROLL_WEB_LINK_LINE, ENROLL_WEB_ACCOUNT_LINES, tailnetNameSuffix, tailnetSuffixLine, PHONE_PRESENT_MESSAGE, PHONE_WALKTHROUGH_LINES, PHONE_NO_TERMINAL_MESSAGE, PHONE_APPEARED_MESSAGE, PHONE_CARRY_ON_MESSAGE, PHONE_WAIT_TIMEOUT_MESSAGE, PAIR_OPEN_APP_MESSAGE, PAIR_READY_LINES, PAIR_RETRY_PROMPT_MESSAGE, PAIR_RETRY_STOP_ANSWER, PAIR_RETRY_LIMIT, PAIR_TIMEOUT_CAUSE_LINES, PAIR_SCREEN_NOT_OPEN_MESSAGE, PAIR_NOBODY_ENTERED_MESSAGE, PAIR_WINDOW_EXPIRED_MESSAGE, pairingExpiryMessage, FIRST_USE_SEND_TEXT, FIRST_USE_ALREADY_COMPLETE_MESSAGE, FIRST_USE_WAITING_MESSAGE, FIRST_USE_REARMED_MESSAGE, FIRST_USE_RECONNECTED_MESSAGE, FIRST_USE_RECONNECT_REARMS, FIRST_USE_REPLY_MESSAGE, FIRST_USE_OPEN_APP_NOTICE, FIRST_USE_RESUME_COMMAND, GATEWAY_SLOW_MESSAGE, FIRST_USE_SKIPPED_MESSAGE, FIRST_USE_RECOVERY_LINE, FIRST_USE_STOP_SENTENCES, FIRST_USE_STOP_FALLBACK, firstUseStopSentence, FIRST_USE_PHONE_SETTLE_MS, FIRST_USE_UNAVAILABLE_MESSAGE, FIRST_USE_REPLY_ERROR_MESSAGE, FIRST_USE_REPLY_RATE_LIMIT_MESSAGE, FIRST_USE_TIMEOUT_MESSAGE, FIRST_USE_PENDING_MESSAGE, SETUP_COMPLETE_MESSAGE, FIRST_USE_TEST_INPUT_MESSAGE, FIRST_USE_WELCOME_UNAVAILABLE_MESSAGE, CERTIFICATE_WAIT_HEALTHY, CERTIFICATE_WAIT_REFUSED, CERTIFICATE_WAIT_TIMEOUT, awaitRouteCertificate, serveApplyArgv, CONVERSATION_ACCESS_DETAILS_HINT, CODEX_REASONING_SUMMARY_MESSAGE, conversationAccessConsentLines, serveConsentLines, defaultGrantConversationAccess, defaultReadRoute, firstUseFailureReason, defaultRelayPort, readModelSignedIn, CLOUDWAYS_PHONE_ADDRESS_REFUSAL, runCloudwaysSetup };
