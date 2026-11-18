const { createHash, randomBytes } = require("node:crypto");

const APPLY_ROUTE_OPERATION = "apply_route";
const CONFIRM_PAIRING_OPERATION = "confirm_pairing";
const PAIR_WITH_PHONE_CODE_OPERATION = "pair_with_phone_code";
const SETUP_APPROVAL_OPERATIONS = Object.freeze([APPLY_ROUTE_OPERATION, CONFIRM_PAIRING_OPERATION]         );
const SETUP_CHAT_OPERATIONS = Object.freeze([
  APPLY_ROUTE_OPERATION,
  CONFIRM_PAIRING_OPERATION,
  PAIR_WITH_PHONE_CODE_OPERATION,
]         );

const APPROVAL_BINDING_PREFIX = "ocuclaw-setup-approval/1";
const APPROVAL_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const APPROVAL_BINDING_PATTERN = /^[0-9a-f]{64}$/;
const PAIRING_SHOWN_TEMPLATE =
  "Check these words match your phone, in this order: {words}. Allow only if they match.";
const PAIRING_WORDS_JOIN = ", ";
const PAIRING_WORD_PATTERN = /^[a-z]+$/;
const PAIRING_WORD_COUNT = 4;

const APPROVAL_CARDS = Object.freeze({
  [APPLY_ROUTE_OPERATION]: Object.freeze({
    title: "Open a private route for your phone",
    lines: Object.freeze([
      "OcuClaw will run this command on this machine:",
      "{shown}",
      "Only devices on your own tailnet can reach OcuClaw through it. It is never public and never uses Tailscale Funnel.",
      "Allow only if you want this.",
    ]),
  }),
  [CONFIRM_PAIRING_OPERATION]: Object.freeze({
    title: "Pair your phone",
    lines: Object.freeze(["{shown}", "If they differ, deny."]),
  }),
});

const CARD_TIMEOUT_SECONDS = 120;
const ROUTE_APPROVAL_TTL_SECONDS = 600;

const OPENCLAW_FAST_APPROVAL_MS = null;
const SETUP_CHAT_ANSWERS = Object.freeze(["yes", "no"]         );
const RECEIPT_THEN = "call_next";

const SETUP_CHAT_RECEIPTS = Object.freeze({
  [PAIR_WITH_PHONE_CODE_OPERATION]: Object.freeze([
    "words_ready", "sent", "no_code", "pairing_code_typed", "malformed",
    "phone_codes_unavailable", "busy", "not_ready", "use_pair_phone", "failed",
  ]),
  [APPLY_ROUTE_OPERATION]: Object.freeze([
    "applied", "already", "declined", "unconfirmed", "stale_binding", "https_off",
    "foreign", "unreadable", "failed", "certificate_timeout", "certificate_refused",
  ]),
  [CONFIRM_PAIRING_OPERATION]: Object.freeze([
    "paired", "approved_waiting", "declined", "unconfirmed", "stale_binding", "expired", "failed",
  ]),
});

const SETUP_CHAT_FORBIDDEN_IN_CARDS = Object.freeze(["relay credential", "relaytoken", "relay token"]);

const PAIRING_STATES = Object.freeze([
  "none", "waiting_for_phone", "words_ready", "approved", "completed", "expired", "failed",
]         );
const TERMINAL_PAIRING_STATES = new Set(["completed", "expired", "failed"]);

function sha256Hex(text        ) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isApprovalOperation(operation     ) {
  return operation === APPLY_ROUTE_OPERATION || operation === CONFIRM_PAIRING_OPERATION;
}

function validWords(words     )                    {
  return Array.isArray(words) && words.length === PAIRING_WORD_COUNT &&
    words.every((word     ) => typeof word === "string" && PAIRING_WORD_PATTERN.test(word));
}

function pairingShownText(words     )         {
  if (!validWords(words)) throw new Error("invalid_input: pairing needs exactly four lowercase words");
  return PAIRING_SHOWN_TEMPLATE.replace("{words}", words.join(PAIRING_WORDS_JOIN));
}

function approvalBinding(operation        , nonce        , shown        )         {
  if (!isApprovalOperation(operation)) throw new Error("invalid_input: not an approval operation");
  if (typeof nonce !== "string" || !APPROVAL_NONCE_PATTERN.test(nonce)) throw new Error("invalid_input: nonce must be 32 hex characters");
  if (typeof shown !== "string" || !shown) throw new Error("invalid_input: nothing to show");
  return sha256Hex(`${APPROVAL_BINDING_PREFIX}\n${operation}\n${nonce}\n${shown}`);
}

function approvalRuleKey(operation        , binding        )         {
  return `ocuclaw_setup:${operation}:${binding}`;
}

function approvalCard(operation        , shown        )                                     {
  const card      = (APPROVAL_CARDS       )[operation];
  if (!card) throw new Error("invalid_input: not an approval operation");
  return { title: card.title, lines: card.lines.map((line        ) => line.split("{shown}").join(shown)) };
}

function approvalCardDescription(operation        , shown        )         {
  return approvalCard(operation, shown).lines.join("\n");
}

function openClawApprovalRequest(operation        , shown        ) {
  const card = approvalCard(operation, shown);
  return {
    requireApproval: {
      title: card.title,
      description: card.lines.join("\n"),
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs: CARD_TIMEOUT_SECONDS * 1000,
      timeoutBehavior: "deny",
    },
  };
}

function setupChatReceipt(operation        , status        , detail      = undefined) {
  const allowed                                = (SETUP_CHAT_RECEIPTS       )[operation];
  if (!allowed || !allowed.includes(status)) throw new Error(`invalid_receipt: ${operation} ${status}`);
  const receipt      = { operation, status, then: RECEIPT_THEN };
  if (typeof detail === "string" && detail) receipt.detail = detail;
  return receipt;
}

function pairingStateOf(exchange     )         {
  if (!exchange || typeof exchange !== "object") return "failed";
  if (exchange.state === "completed") return "completed";
  if (exchange.state === "failed") return exchange.failure?.reason === "expired" ? "expired" : "failed";
  if (exchange.state === "awaiting-phone-completion") return "approved";
  if (exchange.prompt) return "words_ready";
  return "waiting_for_phone";
}

function promptWords(exchange     , exchangeId        )                  {
  const prompt = exchange && exchange.prompt;
  if (!prompt || prompt.exchangeId !== exchangeId || exchange.exchangeId !== exchangeId) return null;
  return validWords(prompt.safetyPhrase) ? [...prompt.safetyPhrase] : null;
}

const STORE_KEY = Symbol.for("ocuclaw.setupApprovalStore.v1");

function defaultNonce() {
  return randomBytes(16).toString("hex");
}

function storeRoot()      {
  const root      = globalThis       ;
  if (!root[STORE_KEY]) {
    root[STORE_KEY] = { records: new Map(), now: () => Date.now(), nonce: defaultNonce };
  }
  return root[STORE_KEY];
}

function stateKey(stateDir     ) {
  return typeof stateDir === "string" ? stateDir : "";
}

function recordFor(stateDir     ) {
  const root = storeRoot();
  const key = stateKey(stateDir);
  let record = root.records.get(key);
  if (!record) {
    record = { route: null, pairing: null, exchange: null, pairingState: "none" };
    root.records.set(key, record);
  }
  return record;
}

function mint(operation        , shown        ) {
  const root = storeRoot();
  const nonce = String(root.nonce());
  if (!APPROVAL_NONCE_PATTERN.test(nonce)) throw new Error("invalid_nonce");
  return { operation, shown, nonce, binding: approvalBinding(operation, nonce, shown), mintedAt: root.now(), consumed: false };
}

function routeEntryLive(entry     ) {
  return !!entry && !entry.consumed && storeRoot().now() - entry.mintedAt < ROUTE_APPROVAL_TTL_SECONDS * 1000;
}

function pairingEntryLive(record     ) {
  const entry = record.pairing;
  return !!entry && !entry.consumed && !!record.exchange && record.exchange.exchangeId === entry.exchangeId;
}

function publicEntry(entry     ) {
  const copy      = { operation: entry.operation, shown: entry.shown, binding: entry.binding, mintedAt: entry.mintedAt };
  if (entry.operation === CONFIRM_PAIRING_OPERATION) {
    copy.words = [...entry.words];
    copy.exchangeId = entry.exchangeId;
  }
  return copy;
}

function pendingRouteApproval(stateDir     , command        )                                       {
  if (typeof command !== "string" || !command.trim()) throw new Error("invalid_input: no route command");
  const record = recordFor(stateDir);
  if (!(routeEntryLive(record.route) && record.route.shown === command)) {
    record.route = mint(APPLY_ROUTE_OPERATION, command);
  }
  return { command, binding: record.route.binding };
}

async function pendingPairing(stateDir     )                                                       {
  const record = recordFor(stateDir);
  const held = record.exchange;
  if (!held) return null;
  let exchange     ;
  try {
    exchange = await held.call("state");
  } catch (_) {

    if (record.exchange === held) releasePairingExchange(stateDir, "failed");
    return null;
  }
  if (record.exchange !== held) return null;
  const state = notePairingState(stateDir, exchange);
  if (TERMINAL_PAIRING_STATES.has(state)) return null;
  const words = state === "words_ready" ? promptWords(exchange, held.exchangeId) : null;
  if (!words) return null;
  const shown = pairingShownText(words);
  const current = record.pairing;
  if (current && current.exchangeId === held.exchangeId && current.shown === shown) {
    if (current.consumed) return null;
    return { words: [...current.words], binding: current.binding };
  }
  record.pairing = { ...mint(CONFIRM_PAIRING_OPERATION, shown), words, exchangeId: held.exchangeId };
  return { words: [...words], binding: record.pairing.binding };
}

function pairingStatus(stateDir     )                    {
  return { state: recordFor(stateDir).pairingState };
}

function approvalsBypassed(_stateDir     )          {
  return false;
}

function noteSetupReceipt(stateDir     , receipt     ) {
  if (!receipt || typeof receipt !== "object" || !(SETUP_CHAT_OPERATIONS                     ).includes(receipt.operation)) return;
  const record = recordFor(stateDir);
  if (!record.receipts) record.receipts = {};
  record.receipts[receipt.operation] = {
    status: receipt.status,
    detail: typeof receipt.detail === "string" ? receipt.detail : null,
    at: storeRoot().now(),
  };
}

function lastSetupReceipt(stateDir     , operation     )      {
  const record = storeRoot().records.get(stateKey(stateDir));
  const last = record && record.receipts ? record.receipts[operation] : null;
  return last ? { ...last } : null;
}

function lookupApproval(stateDir     , binding     )      {
  if (typeof binding !== "string" || !APPROVAL_BINDING_PATTERN.test(binding)) return null;
  const record = recordFor(stateDir);
  if (routeEntryLive(record.route) && record.route.binding === binding) return publicEntry(record.route);
  if (pairingEntryLive(record) && record.pairing.binding === binding) return publicEntry(record.pairing);
  return null;
}

function consumeApproval(stateDir     , binding     , operation      = null)      {
  const entry = lookupApproval(stateDir, binding);
  if (!entry || (operation !== null && entry.operation !== operation)) return null;
  const record = recordFor(stateDir);
  const owner = entry.operation === APPLY_ROUTE_OPERATION ? record.route : record.pairing;
  owner.consumed = true;
  return entry;
}

function holdPairingExchange(stateDir     , exchange                                                            ) {
  if (!exchange || typeof exchange.exchangeId !== "string" || !exchange.exchangeId || typeof exchange.call !== "function") {
    throw new Error("invalid_input: a held exchange needs an id and a control call");
  }
  const record = recordFor(stateDir);
  record.exchange = { exchangeId: exchange.exchangeId, call: exchange.call };
  record.pairing = null;
  record.pairingState = "waiting_for_phone";
}

function heldPairingExchange(stateDir     )                                                                    {
  return recordFor(stateDir).exchange;
}

function releasePairingExchange(stateDir     , finalState         = "none") {
  const record = recordFor(stateDir);
  record.exchange = null;
  record.pairing = null;
  record.pairingState = (PAIRING_STATES                     ).includes(finalState) ? finalState : "failed";
}

function notePairingState(stateDir     , exchange     )         {
  const record = recordFor(stateDir);
  const held = record.exchange;
  if (!held) return record.pairingState;
  if (exchange && typeof exchange.exchangeId === "string" && exchange.exchangeId !== held.exchangeId) {
    releasePairingExchange(stateDir, "failed");
    return "failed";
  }
  const state = pairingStateOf(exchange);
  if (TERMINAL_PAIRING_STATES.has(state)) {
    releasePairingExchange(stateDir, state);
    return state;
  }
  record.pairingState = state;
  return state;
}

function resetSetupApprovalStoreForTests(options      = {}) {
  const root = storeRoot();
  root.records = new Map();
  root.now = typeof options.now === "function" ? options.now : () => Date.now();
  root.nonce = typeof options.nonce === "function" ? options.nonce : defaultNonce;
}

module.exports = { APPLY_ROUTE_OPERATION, CONFIRM_PAIRING_OPERATION, PAIR_WITH_PHONE_CODE_OPERATION, SETUP_APPROVAL_OPERATIONS, SETUP_CHAT_OPERATIONS, APPROVAL_BINDING_PREFIX, APPROVAL_NONCE_PATTERN, APPROVAL_BINDING_PATTERN, PAIRING_SHOWN_TEMPLATE, PAIRING_WORDS_JOIN, PAIRING_WORD_PATTERN, PAIRING_WORD_COUNT, APPROVAL_CARDS, CARD_TIMEOUT_SECONDS, ROUTE_APPROVAL_TTL_SECONDS, OPENCLAW_FAST_APPROVAL_MS, SETUP_CHAT_ANSWERS, RECEIPT_THEN, SETUP_CHAT_RECEIPTS, SETUP_CHAT_FORBIDDEN_IN_CARDS, PAIRING_STATES, pairingShownText, approvalBinding, approvalRuleKey, approvalCard, approvalCardDescription, openClawApprovalRequest, setupChatReceipt, pairingStateOf, promptWords, pendingRouteApproval, pendingPairing, pairingStatus, approvalsBypassed, noteSetupReceipt, lastSetupReceipt, lookupApproval, consumeApproval, holdPairingExchange, heldPairingExchange, releasePairingExchange, notePairingState, resetSetupApprovalStoreForTests };
