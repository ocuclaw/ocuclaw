const { approvalSurfaceFor, SETUP_AFTER_CORE_LABELS, SETUP_CODE_EXPIRES_IN_SECONDS, SETUP_CODE_OPERATION, SETUP_CORE_STEP_COUNT, SETUP_NEXT_CONTRACT, SETUP_RESTART_HOW_BY_PROFILE, SETUP_STEPS } = require("./setup-next-contract.cjs");

const SETUP_RUNS = Object.freeze([
  "grant_access",
  "start_tailscale",
  "enroll",
  "issue_certificate",
  "arm_first_use",
  "await_first_message",
  "restart",
]         );

const TAILSCALE_DOWNLOAD_URLS = Object.freeze({
  macos: "https://tailscale.com/download/mac",
  windows: "https://tailscale.com/download/windows",
  linux: "https://tailscale.com/download/linux",
});
const TAILSCALE_HTTPS_ADMIN_URL = "https://console.tailscale.com/admin/dns";
const TAILSCALE_MACHINES_ADMIN_URL = "https://console.tailscale.com/admin/machines";

const LANE_NAMES                                   = Object.freeze({ openclaw: "OpenClaw", hermes: "Hermes" });
const RESTART_SECONDS                                   = Object.freeze({
  container: 40,
  platform: 30,
  desktop_card: 30,
});

const SETUP_SAY = Object.freeze({

  beginning: "OcuClaw setup is beginning.",
  hostAsk: "I can't tell for sure where this agent runs. Is it a Cloudways Managed AI Agents server?",
  modelSignIn: [
    "No model is signed in yet. Sign in to OpenAI in the Cloudways panel: LLM & Channels → OAuth → OpenAI → Connect.",
    "Using ChatGPT? First turn on device code sign-in in ChatGPT (Settings → Security and login → App security), or ChatGPT refuses the sign-in.",
    "Your agent restarts after that, which can take a few minutes. Then say done.",
  ],
  grantAccess: "Turning on OcuClaw's settings...",
  restartContainer: (lane        ) => `${lane} restarts now, about 40 seconds; then say continue.`,
  restartPlatform: (lane        ) => `${lane} restarts now, about 30 seconds; then say continue.`,
  restartDesktop: "Press Restart gateway on the card Hermes Desktop shows; then say continue.",
  startTailscale: "Starting Tailscale...",

  tailscaleAdopted: "Cloudways' Tailscale is already running here, so OcuClaw uses it. If the server restarts, OcuClaw starts it again the same way.",
  tailscaleChoice: "This server has no Tailscale running yet. Pick the route that fits it.",

  tailscaleSystem: [
    "Install Tailscale on this server yourself, as an admin, following Tailscale's steps for Linux:",
    TAILSCALE_DOWNLOAD_URLS.linux,
    "Say done when it's running.",
  ],
  tailscaleApp: "Install the Tailscale app on this computer, open it and switch it on:",
  tailscaleAppOff: "Open the Tailscale app on this computer and switch it on.",
  sayDone: "Say done when it's on.",
  enroll: "Getting the approval link from Tailscale...",
  approveLink: [
    "Open this link and sign in to Tailscale to approve this server:",
    "Use the Tailscale account your phone uses.",
    "Say done when it's approved.",
  ],
  approveMachine: [
    "Tailscale is signed in, but your tailnet needs an admin to approve this machine.",
    "Open this page and approve it under Machines:",
    "Say done when it's approved.",
  ],
  httpsOff: "Your Tailscale account has HTTPS turned off. Your phone's private route needs it.",
  httpsEnableLink: "Open this link, sign in to Tailscale and turn on HTTPS:",
  httpsAdminPage: "Open this page, sign in to Tailscale and turn on MagicDNS and HTTPS Certificates:",
  certificate: "Getting a certificate for the private route. This can take a minute...",
  routeIntro: "Next I open a private route so only your phone can reach OcuClaw. It stays inside your own Tailscale network and is never public.",
  routeCard: "A card shows the exact command. Press Allow once if you agree.",
  routeChatCommand: "This is the exact command:",
  routeChatAnswer: "Reply yes to run it, or no to stop.",
  phoneAbsent: [
    "Your phone isn't on your Tailscale network yet. On your phone:",
    "1. Open Tailscale.",
    "2. Sign in with the same account as this server.",
    "3. Switch Tailscale on.",
    "Say done when it's on, or skip this and pair anyway.",
  ],
  pairPopup: "A pairing window opens now. Type the code from your phone there, then check the four words.",
  pairCode: `Open Even > OcuClaw on your phone, tap Pair with your agent and tell me the code it shows. The code works once and expires in ${SETUP_CODE_EXPIRES_IN_SECONDS / 60} minutes.`,
  pairWords: (words          ) => `Check these words match your phone, in this order: ${words.join(", ")}. Allow only if they match.`,
  pairCard: "A card shows four words. Press Allow once only if they match your phone, in the same order.",
  pairChatAnswer: "Reply yes only if they match.",
  armFirstUse: "Getting ready for your first message...",

  firstMessageSend: [
    "Now say something to your agent from your glasses and read the reply there.",
    "A welcome card follows. Double-tap it to finish.",
  ],
  firstMessageStill: "Still waiting for your message from the glasses.",

  firstMessage: [
    "Your phone couldn't confirm that my reply reached your glasses.",
    "Did my reply appear on your glasses?",
  ],

  welcome: "Double-tap the welcome on your glasses to finish.",
  done: "Setup is complete.",
});

const SETUP_STUCK_SAY                                   = Object.freeze({
  plugin_not_loaded: "OcuClaw isn't running in your agent yet.",
  plugin_not_loaded_after_restart: "OcuClaw still isn't running after the restart.",
  plugin_version_stale: "Your agent still runs an older OcuClaw than the one installed.",
  tailscaled_missing: "This server has no Tailscale yet. Restart your agent from the Cloudways panel to get the current server image, then say continue.",
  route_conflict: "Something else already uses OcuClaw's private route port on this machine.",
  route_command_unavailable: "I couldn't work out the private route command.",
  setup_surface_unavailable: "Setup can't ask for your approval in this chat. Open your agent's own chat and set up there.",
  custom_route_wrong: "Your own phone address can't reach OcuClaw. Check it, or remove it to use Tailscale.",
  phone_address_on_cloudways: "This Cloudways server reaches your phone only through its own Tailscale, so the phone address set in OcuClaw can't work here. Remove it, then say continue.",
  reply_not_shown: "The reply didn't show on your glasses.",
  model_error: "Your agent's model failed to answer that message.",
  first_message_missing: "No message came from your glasses in time.",

  grant_access_failed: "I couldn't turn on OcuClaw's settings.",
  tailscale_start_failed: "Tailscale didn't start on this machine.",
  enroll_failed: "I couldn't get the approval link from Tailscale.",
  route_failed: "The private route command didn't work.",
  route_declined: "You said no to the private route, so I stopped. OcuClaw needs it to reach your phone.",
  route_unreachable: "The private route is set up, but it can't be reached yet.",
  route_unreadable: "I couldn't read this machine's private route.",
  certificate_refused: "Tailscale refused the certificate for the private route.",
  pairing_unavailable: "Pairing with a phone code isn't available right now.",
  pairing_not_ready: "OcuClaw isn't ready to pair yet.",
  pairing_failed: "Pairing didn't finish.",
  first_use_unavailable: "I couldn't get ready for your first message.",
  agent_merge_needs_terminal: "Bringing your agents together needs a preview first. Run hermes gateway migrate --multiplex --dry-run in a terminal, then say continue.",
  restart_unavailable: "I can't restart Hermes from here. Run hermes gateway restart in a terminal, then say continue.",
});

const SETUP_NOTES = Object.freeze({
  ownAddress: "Your own phone address is set, so Tailscale isn't needed.",
  phoneUnknown: "Couldn't check for your phone here. Pairing shows if it can't connect.",
  phoneSkipped: "You skipped finding your phone. Pairing shows if it can't connect.",
});

const HOST_CHOICE_OPTIONS = Object.freeze([
  Object.freeze({ id: "cloudways", label: "Yes, Cloudways" }),
  Object.freeze({ id: "other", label: "No, somewhere else" }),
]);
const TAILSCALE_CHOICE_OPTIONS = Object.freeze([
  Object.freeze({ id: "system", label: "System Tailscale, installed by the user as an admin" }),
  Object.freeze({ id: "plugin", label: "Tailscale run by OcuClaw from the home folder" }),
]);
const FIRST_MESSAGE_OPTIONS = Object.freeze([
  Object.freeze({ id: "yes", label: "Yes" }),
  Object.freeze({ id: "no", label: "No" }),
]);

const PHONE_ABSENT_OPTIONS = Object.freeze([
  Object.freeze({ id: "done", label: "It's on now" }),
  Object.freeze({ id: "skip", label: "Skip, pair anyway" }),
]);

const SETUP_CARD_TOOLS_STATES = Object.freeze([
  "unknown", "cards_off", "unavailable", "switch_off", "no_servers", "pick", "all_on",
]         );
const CARD_TOOLS_TAP = "Nothing turns on without your tap.";
const cardToolsServers = (cardTools     )        =>
  (Array.isArray(cardTools?.servers) ? cardTools.servers : []).filter((row     ) => row && typeof row === "object" && typeof row.name === "string" && row.name);

function cardToolsState(cardTools     )                {
  const state = cardTools && typeof cardTools === "object" ? cardTools.state : null;
  if (!(SETUP_CARD_TOOLS_STATES                     ).includes(state)) return null;
  return (state === "pick" || state === "all_on") && !cardToolsServers(cardTools).length ? "unknown" : state;
}

function cardToolsSay(cardTools     )                  {
  const state = cardToolsState(cardTools);
  if (!state) return null;
  const servers = cardToolsServers(cardTools);
  if (state === "cards_off") return ["Cards aren't on in your phone's OcuClaw app, so there is nothing to connect your tools to yet.", "Say done once cards are on."];
  if (state === "unavailable") return ["MCP tools can't be used in cards on this host right now.", "Ask me to run the setup doctor and I'll tell you why."];
  if (state === "switch_off") {
    return ["MCP in cards is off on your host, so cards can't read any tool yet.",
      `I'll put a request on your glasses to turn it on. Tap Allow there and I'll list your servers. ${CARD_TOOLS_TAP}`];
  }
  if (state === "no_servers") return ["Your host lists no MCP servers, so there are no tools to turn on for cards.", "Add an MCP server to your agent, then say done."];
  if (state === "pick") {
    const rows = servers.map((row     ) => `${row.name} (${row.cards === true ? "on for cards" : "off for cards"}${row.connected === true ? "" : ", not connected"})`);
    return [`Your MCP servers: ${rows.join(", ")}.`,
      `Which ones should cards be able to read? For each one you name, I'll put a request on your glasses and you tap Allow there. ${CARD_TOOLS_TAP}`];
  }
  if (state === "all_on") {
    return [`Every MCP server on your host is on for cards: ${servers.map((row     ) => row.name).join(", ")}.`, SETUP_SAY.done];
  }
  return ["I couldn't read your MCP servers on your host just now.", "Say done and I'll look again."];
}

const CARD_TOOLS_NEVER = "The user taps Allow on their glasses: never turn one on any other way, and never ask for a server they did not name.";
const SETUP_CARD_TOOLS_NEXT                                   = Object.freeze({
  switch_off: `Call request_card_setup with what "mcp" and during "setup", wait for its answer, then call next again. ${CARD_TOOLS_NEVER}`,
  pick: `Ask which servers cards may read. For each one the user names, call request_card_setup with what "server", that server and during "setup", and wait for each answer before the next. Then call next again. ${CARD_TOOLS_NEVER}`,
});

function cardToolsBlock(cardTools     ) {
  const next = SETUP_CARD_TOOLS_NEXT[cardToolsState(cardTools)          ];
  return { state: cardToolsState(cardTools), ...(next ? { next } : {}), servers: cardToolsServers(cardTools).map((row     ) => ({ name: row.name, connected: row.connected === true, cards: row.cards === true })) };
}

const SETUP_JEV_STATES = Object.freeze([
  "no_key", "key_saved", "loading", "not_checked", "working", "key_rejected", "unreachable", "unknown",
]         );
const SETUP_JEV_SAY = Object.freeze({
  no_key: Object.freeze([
    "You'll need a TypeSafe key. On a computer, go to console.typesafe.ai, sign in or create an account, and create an API key.",
    "Then on your phone, tap Set up Jev on Home's Optional setup card and paste the key there. I never see the key, and the phone asks you before it turns anything on.",
    "Say done when Jev is on.",
  ]),
  key_saved: (lane        ) => [
    "Your TypeSafe key is saved, but Smart interfaces is still off.",

    `On your phone, tap Set up Jev, then Turn on.${lane === "hermes" ? " If it reads Turn on & restart Hermes, Hermes needs one restart to load a new key." : ""} Say done when it's on.`,
  ],
  loading: (lane        ) => [
    `Smart interfaces is turned on, but ${lane === "hermes" ? "Hermes" : "OpenClaw"} hasn't loaded it yet.`,
    "Say done in a moment and I'll check again.",
  ],
  not_checked: (lane        ) => [
    `${lane === "hermes" ? "Hermes" : "OpenClaw"} has Smart interfaces loaded, but Jev hasn't been checked yet.`,
    "On your phone, open Set up Jev to run the check. Say done when it's finished.",
  ],
  working: (lane        ) => [`${lane === "hermes" ? "Hermes" : "OpenClaw"} has it loaded and Jev passed its check, so you're set.`],
  key_rejected: Object.freeze([
    "TypeSafe didn't accept this key.",
    "On your phone, open Set up Jev and tap Change key, then paste a new key from console.typesafe.ai. Say done when it's saved.",
  ]),
  unreachable: Object.freeze([
    "Your host couldn't reach TypeSafe when it checked Jev.",
    "On your phone, open Set up Jev and tap Check again. Say done when it passes.",
  ]),
  unknown: Object.freeze([
    "I couldn't read Jev's setup on your host just now.",
    "Say done and I'll look again.",
  ]),
});

function jevSay(state     , lane        )                  {
  if (!(SETUP_JEV_STATES                     ).includes(state)) return null;
  const entry      = (SETUP_JEV_SAY                       )[state];
  const lines           = typeof entry === "function" ? entry(lane) : [...entry];
  return state === "working" ? [...lines, SETUP_SAY.done] : lines;
}

const DONE              = { state: "done" };
const skipped = (note        )              => ({ state: "skipped", note });
const working = (line        , run        )              => ({
  stop: { status: "working", say: [line], input: { kind: "none", then: "call_next" }, run },
});
const link = (say          , url               )              => ({
  stop: { status: "waiting", say, input: { kind: "link", url, reply: "done" } },
});
const choice = (say          , chooser        , options                , facts      )              => ({
  stop: {
    status: "waiting",
    say,
    input: {
      kind: "choice",
      chooser,
      param: "choice",
      options: options.map((option) => ({ ...option })),
      ...(facts && typeof facts === "object" ? { facts: { ...facts } } : {}),
    },
  },
});
const stuckAt = (code        , say                  = null, checked           = [], tried           = [])              => ({
  stop: {
    status: "stuck",
    say: say ?? (SETUP_STUCK_SAY[code] ? [SETUP_STUCK_SAY[code]] : []),
    input: { kind: "none", then: "troubleshoot" },
    stuck: { code, checked: [...checked], tried: [...tried] },
  },
});

function customRoute(facts     ) {
  return facts.phoneAddress === "ready" || facts.phoneAddress === "unverified" || facts.phoneAddress === "wrong";
}

function stepHostModel(facts     )              {
  if (facts.hostLikely === true) return choice([SETUP_SAY.hostAsk], "user", HOST_CHOICE_OPTIONS);

  if (facts.profile !== "cloudways") return DONE;

  if (customRoute(facts)) return stuckAt("phone_address_on_cloudways", null, ["phone address", "host"]);
  if (facts.model === "signed_out") return link([...SETUP_SAY.modelSignIn], null);
  return DONE;
}

function stepPluginAccess(facts     )              {

  return facts.access === "granted" ? DONE : working(SETUP_SAY.grantAccess, "grant_access");
}

function stepLoaded(facts     )              {
  if (facts.loaded === "yes") return DONE;
  if (facts.loaded === "stale") return stuckAt("plugin_version_stale", null, ["running OcuClaw version", "installed OcuClaw version"]);

  if (facts.restarted === true) return stuckAt("plugin_not_loaded_after_restart", null, ["plugin loaded"], ["one restart"]);
  if (facts.lane === "openclaw" && facts.profile === "cloudways") {
    return stuckAt("plugin_not_loaded", null, ["plugin loaded"]);
  }
  const how = (SETUP_RESTART_HOW_BY_PROFILE                          )[facts.profile];
  const lane = LANE_NAMES[facts.lane];
  const line = how === "container" ? SETUP_SAY.restartContainer(lane)
    : how === "desktop_card" ? SETUP_SAY.restartDesktop
    : SETUP_SAY.restartPlatform(lane);
  return {
    stop: {
      status: "restarting",
      say: [line],
      input: { kind: "none", then: "end_turn" },
      restart: { how, approxSeconds: RESTART_SECONDS[how], resumeWord: "continue" },
      run: "restart",
    },
  };
}

function stepPrivateNetwork(facts     )              {
  if (customRoute(facts)) return skipped(SETUP_NOTES.ownAddress);
  if (facts.tailscale === "running") return DONE;
  const profile = facts.profile;
  if (profile === "cloudways") {
    if (facts.tailscale === "absent") return stuckAt("tailscaled_missing", null, ["/usr/bin/tailscaled"]);
    return working(SETUP_SAY.startTailscale, "start_tailscale");
  }
  if (profile === "server" || profile === "container") {

    if (facts.tailscale === "absent" && facts.tailscaleFacts?.tailscaleInstalled === false) {
      return link([...SETUP_SAY.tailscaleSystem], TAILSCALE_DOWNLOAD_URLS.linux);
    }
    if (facts.tailscaleChoice === "plugin") return working(SETUP_SAY.startTailscale, "start_tailscale");
    if (facts.tailscaleChoice === "system") return link([...SETUP_SAY.tailscaleSystem], TAILSCALE_DOWNLOAD_URLS.linux);
    return choice([SETUP_SAY.tailscaleChoice], "agent", TAILSCALE_CHOICE_OPTIONS, facts.tailscaleFacts ?? {});
  }

  if (facts.tailscale === "stopped") return link([SETUP_SAY.tailscaleAppOff, SETUP_SAY.sayDone], null);
  const url = (TAILSCALE_DOWNLOAD_URLS                          )[facts.os] ?? TAILSCALE_DOWNLOAD_URLS.linux;
  return link([SETUP_SAY.tailscaleApp, url, SETUP_SAY.sayDone], url);
}

function stepApproveMachine(facts     )              {
  if (customRoute(facts)) return skipped(SETUP_NOTES.ownAddress);
  if (facts.tailnet === "online") return DONE;

  if (facts.tailnet === "needs_approval") {
    const [first, second, ...rest] = SETUP_SAY.approveMachine;
    return link([first, second, TAILSCALE_MACHINES_ADMIN_URL, ...rest], TAILSCALE_MACHINES_ADMIN_URL);
  }
  if (typeof facts.enrollUrl !== "string" || !facts.enrollUrl) return working(SETUP_SAY.enroll, "enroll");
  const [first, ...rest] = SETUP_SAY.approveLink;
  return link([first, facts.enrollUrl, ...rest], facts.enrollUrl);
}

function stepPrivateRoute(facts     )              {
  if (facts.phoneAddress === "wrong") return stuckAt("custom_route_wrong", null, ["phone address check"]);
  if (customRoute(facts)) return skipped(SETUP_NOTES.ownAddress);
  if (facts.route === "ready") return DONE;
  if (facts.route === "conflict") return stuckAt("route_conflict", null, ["tailscale serve status"]);
  if (facts.https === "off") {
    const url = typeof facts.httpsEnableUrl === "string" && facts.httpsEnableUrl ? facts.httpsEnableUrl : TAILSCALE_HTTPS_ADMIN_URL;
    const intro = url === TAILSCALE_HTTPS_ADMIN_URL ? SETUP_SAY.httpsAdminPage : SETUP_SAY.httpsEnableLink;
    return link([SETUP_SAY.httpsOff, intro, url, SETUP_SAY.sayDone], url);
  }
  if (facts.route === "issuing") return working(SETUP_SAY.certificate, "issue_certificate");
  const surface = approvalSurfaceFor(facts.lane, facts.interface ?? "", "route", facts.approvals !== false);
  if (surface === null) return stuckAt("setup_surface_unavailable", null, ["chat interface"]);
  if (typeof facts.routeCommand !== "string" || typeof facts.routeBinding !== "string") {
    return stuckAt("route_command_unavailable", null, ["route command"]);
  }
  const shows = [facts.routeCommand];
  const say = surface === "chat_yes"
    ? [SETUP_SAY.routeIntro, SETUP_SAY.routeChatCommand, facts.routeCommand, SETUP_SAY.routeChatAnswer]
    : [SETUP_SAY.routeIntro, SETUP_SAY.routeCard];
  return {
    stop: {
      status: "waiting",
      say,
      input: {
        kind: "approval",
        surface,
        operation: "apply_route",
        binding: facts.routeBinding,
        ...(surface === "chat_yes" ? { param: "answer" } : {}),
        shows,
      },
    },
  };
}

function stepPhoneOnTailnet(facts     )              {
  if (customRoute(facts)) return skipped(SETUP_NOTES.ownAddress);
  if (facts.phone === "present") return DONE;
  if (facts.phone === "absent") return choice([...SETUP_SAY.phoneAbsent], "user", PHONE_ABSENT_OPTIONS);
  if (facts.phone === "skipped") return skipped(SETUP_NOTES.phoneSkipped);
  return skipped(SETUP_NOTES.phoneUnknown);
}

function stepPair(facts     )              {
  if (facts.paired === true) return DONE;
  const surface = approvalSurfaceFor(facts.lane, facts.interface ?? "", "pairing", facts.approvals !== false);
  if (surface === null) return stuckAt("setup_surface_unavailable", null, ["chat interface"]);
  if (surface === "popup") {
    return { stop: { status: "waiting", say: [SETUP_SAY.pairPopup], input: { kind: "approval", surface, operation: "pair_phone" } } };
  }
  const words = facts.pairingWords;
  if (Array.isArray(words) && words.length > 0 && typeof facts.pairingBinding === "string") {
    const line = SETUP_SAY.pairWords(words);
    const say = surface === "chat_yes" ? [line, SETUP_SAY.pairChatAnswer] : [SETUP_SAY.pairCard];
    return {
      stop: {
        status: "waiting",
        say,
        input: {
          kind: "approval",
          surface,
          operation: "confirm_pairing",
          binding: facts.pairingBinding,
          ...(surface === "chat_yes" ? { param: "answer" } : {}),
          shows: [line],
        },
      },
    };
  }
  return {
    stop: {
      status: "waiting",
      say: [SETUP_SAY.pairCode],
      input: { kind: "code", operation: SETUP_CODE_OPERATION, param: "code", expiresInSeconds: SETUP_CODE_EXPIRES_IN_SECONDS },
    },
  };
}

function firstMessageStillLeft(minutes        )         {
  return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} left to send one. I keep checking, so you don't need to type here.`;
}

function stepFirstMessage(facts     )              {
  if (facts.firstUse === "confirmed") return DONE;
  if (facts.firstUse === "answered_no") return stuckAt("reply_not_shown", null, ["wearer answer"]);
  if (facts.firstUse === "model_error") return stuckAt("model_error", null, ["first reply run"]);
  if (facts.firstUse === "no_message") return stuckAt("first_message_missing", null, ["phone message"]);
  if (facts.firstUse === "waiting") return choice([...SETUP_SAY.firstMessage], "user", FIRST_MESSAGE_OPTIONS);
  if (facts.firstUse === "sending") {
    if (facts.lane !== "openclaw" && facts.firstUseWake === "armed") {

      return {
        stop: {
          status: "waiting",
          say: [...SETUP_SAY.firstMessageSend],
          input: { kind: "glasses", then: "end_turn" },
        },
      };
    }
    const then = facts.lane === "openclaw" ? "end_turn" : "call_next";
    const left = facts.firstUseLeftMin;

    const say = facts.firstUseWaited === true
      ? [SETUP_SAY.firstMessageStill, ...SETUP_SAY.firstMessageSend, ...(Number.isInteger(left) && left > 0 ? [firstMessageStillLeft(left)] : [])]
      : [...SETUP_SAY.firstMessageSend];
    return {
      stop: {
        status: "waiting",
        say,
        input: { kind: "glasses", then },
        ...(then === "call_next" ? { run: "await_first_message" } : {}),
      },
    };
  }
  return working(SETUP_SAY.armFirstUse, "arm_first_use");
}

const STEP_RULES                                           = [
  stepHostModel,
  stepPluginAccess,
  stepLoaded,
  stepPrivateNetwork,
  stepApproveMachine,
  stepPrivateRoute,
  stepPhoneOnTailnet,
  stepPair,
  stepFirstMessage,
];

function readerStuck(facts     , stepId        )                     {
  const stuck = facts.stuck;
  if (!stuck || typeof stuck !== "object" || stuck.step !== stepId || typeof stuck.code !== "string") return null;
  const lines = Array.isArray(stuck.say) ? stuck.say.filter((line         ) => typeof line === "string") : null;
  const list = (value         ) => (Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
  return stuckAt(stuck.code, lines, list(stuck.checked), list(stuck.tried));
}

function decideNext(facts     )                                                      {
  const progressSteps                        = [];
  let stop              = null;
  let stopAt = "";
  for (let i = 0; i < SETUP_STEPS.length; i += 1) {
    const step = SETUP_STEPS[i];
    const entry                      = { id: step.id, number: step.number, label: step.label };
    if (stop) {
      progressSteps.push({ ...entry, state: "todo" });
      continue;
    }
    const outcome = STEP_RULES[i](facts);
    const reported = "stop" in outcome ? readerStuck(facts, step.id) ?? outcome : outcome;
    if ("stop" in reported) {
      stop = reported.stop;
      stopAt = step.id;
      progressSteps.push({ ...entry, state: stop.status === "stuck" ? "stuck" : "current" });
    } else if (reported.state === "skipped") {
      progressSteps.push({ ...entry, state: "skipped", note: reported.note });
    } else {
      progressSteps.push({ ...entry, state: "done" });
    }
  }
  if (!stop) {
    const jevLines = jevSay(facts.jev, facts.lane) ?? cardToolsSay(facts.cardTools);
    stop = { status: "done", say: jevLines ?? [SETUP_SAY.done], input: { kind: "none", then: "end_turn" } };
    stopAt = "done";
  }
  const core = SETUP_STEPS.find((step) => step.id === stopAt);
  const result                      = {
    contract: SETUP_NEXT_CONTRACT,
    lane: facts.lane,
    profile: facts.profile,
    step: stopAt,
    status: stop .status,

    say: [

      ...(facts.beginning === true && stop .status !== "stuck" && stopAt !== "done" ? [SETUP_SAY.beginning] : []),
      ...(facts.tailscaleAdopted === true && stop .status !== "stuck" ? [SETUP_SAY.tailscaleAdopted] : []),

      ...(facts.welcome === "pending" && stopAt === "done" ? [SETUP_SAY.welcome] : []),
      ...stop .say,
    ],
    input: stop .input,
    ...(stop .restart ? { restart: stop .restart } : {}),
    ...(stop .stuck ? { stuck: stop .stuck } : {}),

    ...(stopAt === "done" && jevSay(facts.jev, facts.lane) ? { jev: { state: facts.jev } } : {}),

    ...(stopAt === "done" && !jevSay(facts.jev, facts.lane) && cardToolsSay(facts.cardTools) ? { cardTools: cardToolsBlock(facts.cardTools) } : {}),
    progress: {
      current: stopAt,
      number: core ? core.number : null,
      of: SETUP_CORE_STEP_COUNT,
      label: core ? core.label : (SETUP_AFTER_CORE_LABELS                          )[stopAt],
      steps: progressSteps,
    },
  };
  return { result, run: stop .run ?? null };
}

module.exports = { SETUP_RUNS, TAILSCALE_DOWNLOAD_URLS, TAILSCALE_HTTPS_ADMIN_URL, TAILSCALE_MACHINES_ADMIN_URL, SETUP_SAY, SETUP_STUCK_SAY, SETUP_NOTES, HOST_CHOICE_OPTIONS, TAILSCALE_CHOICE_OPTIONS, FIRST_MESSAGE_OPTIONS, PHONE_ABSENT_OPTIONS, SETUP_CARD_TOOLS_STATES, cardToolsSay, SETUP_CARD_TOOLS_NEXT, SETUP_JEV_STATES, SETUP_JEV_SAY, jevSay, firstMessageStillLeft, decideNext };
