const { randomBytes: nodeRandomBytes } = require("node:crypto");

const { constantTimeEqual } = require("../constant-time-equal.cjs");
const { NOISE_NN_RESPONDER_MESSAGE_LENGTH, NOISE_PUBLIC_KEY_LENGTH, NOISE_SUITE_UNAVAILABLE_REASON, PAIRING_NOISE_PROTOCOL_NAME } = require("./noise-suite.cjs");
const { buildPairingPrologue } = require("./pairing-prologue.cjs");
const { canonicalizeRelayAddressV1 } = require("./relay-address.cjs");
const { deriveSafetyPhrase, formatSafetyPhrase } = require("./safety-phrase.cjs");

const EXCHANGE_LIFETIME_MS = 120_000;

const MAX_PHONE_SUBMISSIONS = 3;

const COMPLETION_WINDOW_MS = 60_000;

const EXCHANGE_ID_BYTES = 16;

const PAIRING_CODE_BITS = 40;

const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE_LENGTH = PAIRING_CODE_BITS / 5;

const MAX_PHONE_LABEL_LENGTH = 32;

const MAX_RAW_PHONE_LABEL_LENGTH = 512;

const CONSUMED_ID_MEMORY = 64;

const EXCHANGE_ID_PATTERN = /^[0-9a-f]{32}$/;

const MAX_RAW_PAIRING_CODE_LENGTH = 64;

const FAILURE_MESSAGES                                       = {

  "secure-pairing-unavailable":
    "Secure pairing could not be started on this computer, so nothing was sent.",
  "invalid-address":
    "The relay address is not usable for pairing, so pairing did not start.",
  "credential-unavailable":
    "This computer could not read its own relay credential, so nothing was sent.",
  expired: "The pairing window closed before the phone finished. Start pairing again.",
  "exchange-not-found":
    "That pairing request is no longer active. Start pairing again.",
  "exchange-already-used":
    "That pairing request was already used. Start pairing again.",
  "too-many-attempts":
    "Too many pairing attempts were made for this request. Start pairing again.",
  "phone-hello-missing":
    "No phone had joined this pairing request, so there was nothing to approve.",
  "wrong-client-role":
    "Only the phone app can pair. Developer tools cannot complete pairing.",
  "pairing-code-mismatch":
    "That pairing code does not match the one shown on this computer.",
  "malformed-message":
    "The phone sent something this computer could not read, so pairing stopped.",
  replayed:
    "A pairing message arrived out of order, so pairing stopped for safety.",
  "approval-denied":
    "Pairing was not approved on this computer, so nothing was sent.",
  "delivery-interrupted":
    "The connection dropped while pairing was being completed, so nothing was confirmed. Start pairing again.",
  "transport-failed":
    "The connection to the phone dropped, so pairing stopped. Start pairing again.",
  "internal-error":
    "This computer could not complete pairing safely, so nothing was sent. Start pairing again.",
  "completion-window-elapsed":
    "The phone did not confirm pairing in time. Start pairing again.",
  "completion-not-authenticated":
    "The phone's confirmation could not be verified, so pairing stopped.",
  cancelled: "Pairing was cancelled.",
  superseded: "A newer pairing request replaced this one.",

  "channel-conflict":
    "Two different devices tried to use this pairing request, so it was stopped. " +
    "Start pairing again on your computer and use just one of the two ways.",
};

                                                         

                          

                                               

function requireEntropy(
  randomBytes                              ,
  size        ,
)             {
  const bytes = randomBytes(size);
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
    throw new Error(`entropy source returned a short draw; ${size} bytes required`);
  }
  return bytes;
}

function generateRelayCredential(
  randomBytes                               = nodeRandomBytes,
)         {
  return toBase64Url(requireEntropy(randomBytes, 32));
}

function generatePairingCode(
  randomBytes                               = nodeRandomBytes,
)         {
  const bytes = requireEntropy(randomBytes, PAIRING_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    code += PAIRING_CODE_ALPHABET[(bytes[i]          ) % PAIRING_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizePairingCode(input         )                {
  if (typeof input !== "string") return null;
  if (input.length > MAX_RAW_PAIRING_CODE_LENGTH) return null;
  let normalized = "";
  for (const rawChar of input.toUpperCase()) {
    if (rawChar === "-" || rawChar === " ") continue;
    let char = rawChar;
    if (char === "O") char = "0";
    else if (char === "I" || char === "L") char = "1";
    else if (char === "U") char = "V";
    if (!PAIRING_CODE_ALPHABET.includes(char)) return null;
    normalized += char;
    if (normalized.length > PAIRING_CODE_LENGTH) return null;
  }
  return normalized.length === PAIRING_CODE_LENGTH ? normalized : null;
}

function sanitizePhoneLabel(input         )         {
  if (typeof input !== "string") return "Unknown device";

  if (input.length > MAX_RAW_PHONE_LABEL_LENGTH) return "Unknown device";
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    const allowed =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      char === " " ||
      char === "." ||
      char === "_" ||
      char === "-" ||
      char === "(" ||
      char === ")" ||
      char === "'";
    if (allowed) out += char;
    if (out.length >= MAX_PHONE_LABEL_LENGTH) break;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 0 ? out : "Unknown device";
}

function toBase64Url(bytes            )         {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value         , maxEncodedLength        )                    {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > maxEncodedLength) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return new Uint8Array(Buffer.from(value, "base64url"));
  } catch {
    return null;
  }
}

const MAX_ENCODED_HANDSHAKE_MESSAGE_LENGTH = 68;

const MAX_ENCODED_CONFIRMATION_LENGTH = 1024;

function toHex(bytes            )         {
  return Buffer.from(bytes).toString("hex");
}

function bytesEqual(a            , b            )          {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i]          ) ^ (b[i]          );
  return diff === 0;
}

function isAllZero(bytes            )          {
  let acc = 0;
  for (const byte of bytes) acc |= byte;
  return acc === 0;
}

function defaultNow()         {

  return Number(process.hrtime.bigint() / 1_000_000n);
}

                                                             

                                                                        
                                     

const TERMINAL_STATES                            = new Set(["completed", "failed"]);

function failure(reason                      , message         )                 {
  return { reason, message: message ?? FAILURE_MESSAGES[reason] };
}

function createPairingExchangeHost(
  options                            ,
)                      {
  const {
    transport,
    noiseSuite,
    readRelayCredential,
    resolveClientRole = () => "unknown",
    onPairingCompleted = () => {},
    now = defaultNow,
    randomBytes = nodeRandomBytes,
    allowTestStandInNoiseSuite = false,
  } = options;

  if (noiseSuite && noiseSuite.protocolName !== PAIRING_NOISE_PROTOCOL_NAME) {

    throw new Error(
      `Refusing to build a pairing host on protocol "${noiseSuite.protocolName}"; ` +
        `${PAIRING_NOISE_PROTOCOL_NAME} is required.`,
    );
  }

  if (
    noiseSuite &&
    noiseSuite.assurance !== "vendor-primitives-official-vectors" &&
    allowTestStandInNoiseSuite !== true
  ) {

    throw new Error(
      "Refusing to build a pairing host on a Noise suite that is not the " +
        "vendor-primitives suite proven against the official Noise vectors.",
    );
  }

  let exchange                        = null;
  const consumedIds           = [];

  let initiationTicket = 0;

  function isStale(target                )          {
    return exchange !== target || TERMINAL_STATES.has(target.state);
  }

  function consumeId(id        )       {
    consumedIds.push(id);
    while (consumedIds.length > CONSUMED_ID_MEMORY) consumedIds.shift();
  }

  function wasConsumed(id        )          {
    return consumedIds.includes(id);
  }

  function destroyKeyMaterial(target                )       {
    try {
      target.session?.destroy();
    } catch {

    }
    try {
      target.handshake?.destroy();
    } catch {

    }

    try {
      target.ephemeral?.destroy();
    } catch {

    }
    target.session = null;
    target.handshake = null;
    target.ephemeral = null;
  }

  function sendQuietly(frame              )       {
    try {

      void Promise.resolve(transport.send(frame)).catch(() => {});
    } catch {

    }
  }

  async function sendOrFail(target                , frame              )                   {
    let delivery                      ;
    try {
      delivery = transport.send(frame);
    } catch {
      failClosed(target, "transport-failed", { notifyPeer: false });
      return false;
    }

    if (delivery) {
      try {
        await delivery;
      } catch {
        failClosed(target, "transport-failed", { notifyPeer: false });
        return false;
      }
    }
    return true;
  }

  function failClosed(
    target                ,
    reason                      ,
    options                                    = {},
  )                 {
    const { notifyPeer = true } = options;
    const detail = failure(reason);
    if (!TERMINAL_STATES.has(target.state)) {
      target.state = "failed";
      target.failure = detail;
      target.approved = false;
      target.completion = null;
      destroyKeyMaterial(target);
      consumeId(target.id);
      if (notifyPeer) {
        sendQuietly({
          type: "pairing.failed",
          exchangeId: target.id,
          reason: detail.reason,
          message: detail.message,
        });
      }
    }
    return detail;
  }

  function evaluateDeadlines()       {
    if (!exchange || TERMINAL_STATES.has(exchange.state)) return;
    const current = now();
    if (exchange.completion) {

      if (current >= exchange.completion.deadline) {
        failClosed(exchange, "completion-window-elapsed");
      }
      return;
    }
    if (current >= exchange.expiresAt) {
      failClosed(exchange, "expired");
    }
  }

  async function beginExchange(
    initiation                   ,
    address        ,

    dualRoute = false,
  )

    {
    if (!noiseSuite) {

      return {
        ok: false,
        ...failure("secure-pairing-unavailable", NOISE_SUITE_UNAVAILABLE_REASON),
      };
    }
    const addressCheck = canonicalizeRelayAddressV1(address);
    if (!addressCheck.ok) {
      return { ok: false, ...failure("invalid-address") };
    }

    let idBytes            ;
    let pairingCode               ;
    try {
      idBytes = requireEntropy(randomBytes, EXCHANGE_ID_BYTES);
      pairingCode =
        initiation === "manual" || dualRoute ? generatePairingCode(randomBytes) : null;
    } catch {
      return { ok: false, ...failure("secure-pairing-unavailable") };
    }

    const id = toHex(idBytes);

    const ticket = (initiationTicket += 1);

    let ephemeral                       ;
    try {
      ephemeral = await noiseSuite.generateEphemeral();
    } catch {
      return { ok: false, ...failure("secure-pairing-unavailable") };
    }

    if (ticket !== initiationTicket) {
      try {
        ephemeral.destroy();
      } catch {

      }
      return { ok: false, ...failure("superseded") };
    }

    if (exchange && !TERMINAL_STATES.has(exchange.state)) {
      failClosed(exchange, "superseded");
    }

    const createdAt = now();
    const next                 = {
      id,
      initiation,
      address: addressCheck.address,
      exchangeIdBytes: idBytes,
      pairingCode,
      createdAt,
      expiresAt: createdAt + EXCHANGE_LIFETIME_MS,
      handshake: null,
      ephemeral,
      hostEphemeralPublicKey: ephemeral.publicKey,
      state: "awaiting-phone-hello",
      submissions: 0,

      offerSent: initiation === "qr",
      manualOfferSent: false,
      boundChannel: null,
      submittedMessages: new Set        (),
      session: null,
      safetyPhrase: null,
      phoneLabel: null,
      approved: false,
      completion: null,
      credentialExposure: "none",
      failure: null,
    };
    exchange = next;
    return { ok: true, exchange: next };
  }

  function chargeSubmission(target                )          {
    target.submissions += 1;
    if (target.submissions > MAX_PHONE_SUBMISSIONS) {
      failClosed(target, "too-many-attempts");
      return false;
    }
    return true;
  }

  async function rejectRetryable(
    target                ,
    reason                      ,
  )                {

    if (target.submissions >= MAX_PHONE_SUBMISSIONS) {
      failClosed(target, "too-many-attempts");
      return;
    }
    await sendOrFail(target, {
      type: "pairing.rejected",
      exchangeId: target.id,
      reason,
      message: FAILURE_MESSAGES[reason],
      attemptsRemaining: Math.max(0, MAX_PHONE_SUBMISSIONS - target.submissions),
    });
  }

  function requireAppRole(target                )          {

    let role                   ;
    try {
      role = resolveClientRole();
    } catch {
      role = "unknown";
    }
    if (role !== "app") {
      failClosed(target, "wrong-client-role");
      return false;
    }
    return true;
  }

  async function handleManualRequest(target                , frame              )                {

    if (!requireAppRole(target)) return;

    if (
      target.pairingCode !== null &&
      target.boundChannel !== null &&
      target.boundChannel !== "manual"
    ) {
      failClosed(target, "channel-conflict");
      return;
    }

    if (
      target.pairingCode === null ||
      target.manualOfferSent ||
      target.state !== "awaiting-phone-hello"
    ) {
      return;
    }

    const supplied = normalizePairingCode(frame.pairingCode);

    const expected = normalizePairingCode(target.pairingCode);
    if (supplied === null || expected === null || !constantTimeEqual(supplied, expected)) {

      if (!chargeSubmission(target)) return;
      await rejectRetryable(target, "pairing-code-mismatch");
      return;
    }

    const bindsManualNow = target.boundChannel === null;
    if (bindsManualNow) target.boundChannel = "manual";

    if (bindsManualNow && noiseSuite) {
      let rotated                       ;
      try {
        rotated = await noiseSuite.generateEphemeral();
      } catch {
        failClosed(target, "secure-pairing-unavailable");
        return;
      }

      evaluateDeadlines();
      if (isStale(target)) {
        try {
          rotated.destroy();
        } catch {

        }
        return;
      }
      const previous = target.ephemeral;
      target.ephemeral = rotated;
      target.hostEphemeralPublicKey = rotated.publicKey;
      try {
        previous?.destroy();
      } catch {

      }
    }

    const offerWasAlreadyPublic = target.offerSent;
    target.offerSent = true;
    target.manualOfferSent = true;
    if (
      !(await sendOrFail(target, {
        type: "pairing.offer",
        exchangeId: target.id,
        hostKey: toBase64Url(target.hostEphemeralPublicKey),
      }))
    ) {

      target.offerSent = offerWasAlreadyPublic;
      target.manualOfferSent = false;
    }
  }

  async function handleHello(target                , frame              )                {
    if (target.state !== "awaiting-phone-hello" || !target.offerSent) {
      failClosed(target, "replayed");
      return;
    }
    if (!requireAppRole(target)) return;

    const phoneMessage = fromBase64Url(
      frame.handshakeMessage,
      MAX_ENCODED_HANDSHAKE_MESSAGE_LENGTH,
    );

    if (phoneMessage && target.submittedMessages.has(toBase64Url(phoneMessage))) {
      failClosed(target, "replayed");
      return;
    }
    if (!chargeSubmission(target)) return;

    if (
      !phoneMessage ||
      phoneMessage.length !== NOISE_NN_RESPONDER_MESSAGE_LENGTH ||
      isAllZero(phoneMessage.subarray(0, NOISE_PUBLIC_KEY_LENGTH))
    ) {
      await rejectRetryable(target, "malformed-message");
      return;
    }
    target.submittedMessages.add(toBase64Url(phoneMessage));

    const phoneEphemeralPublicKey = phoneMessage.slice(0, NOISE_PUBLIC_KEY_LENGTH);

    const ephemeral = target.ephemeral;
    if (!ephemeral || !noiseSuite) {
      failClosed(target, "secure-pairing-unavailable");
      return;
    }

    let handshake                         ;
    try {
      const prologue = buildPairingPrologue({
        address: target.address,
        exchangeId: target.exchangeIdBytes,
        hostEphemeralPublicKey: target.hostEphemeralPublicKey,
        phoneEphemeralPublicKey,
      });
      handshake = await noiseSuite.createInitiator({ prologue, ephemeral });
    } catch {

      failClosed(target, "malformed-message");
      return;
    }
    target.handshake = handshake;

    if (!bytesEqual(handshake.initiatorMessage, target.hostEphemeralPublicKey)) {
      failClosed(target, "secure-pairing-unavailable");
      return;
    }

    let digest            ;
    let session                       ;
    try {
      const completion = await handshake.readResponderMessage(phoneMessage);
      digest = completion.handshakeDigest;
      session = completion.session;
    } catch {

      failClosed(target, "malformed-message");
      return;
    }

    evaluateDeadlines();
    if (isStale(target)) {
      try {
        session.destroy();
      } catch {

      }
      return;
    }

    target.session = session;

    let phrase                   ;
    try {
      phrase = deriveSafetyPhrase(digest);
    } catch {
      failClosed(target, "malformed-message");
      return;
    }

    if (target.boundChannel === null) target.boundChannel = "qr";

    target.safetyPhrase = phrase;
    target.phoneLabel = sanitizePhoneLabel(frame.clientName);
    target.state = "awaiting-local-approval";

    await sendOrFail(target, { type: "pairing.awaiting-approval", exchangeId: target.id });
  }

  async function handleCompletion(target                , frame              )                {
    if (target.state !== "awaiting-phone-completion" || !target.completion || !target.session) {
      failClosed(target, "replayed");
      return;
    }
    if (now() >= target.completion.deadline) {
      failClosed(target, "completion-window-elapsed");
      return;
    }

    const sealed = fromBase64Url(frame.confirmation, MAX_ENCODED_CONFIRMATION_LENGTH);
    if (!sealed) {
      failClosed(target, "completion-not-authenticated");
      return;
    }

    let challenge         ;
    try {
      const opened = await target.session.decrypt(sealed);
      challenge = (JSON.parse(Buffer.from(opened).toString("utf8"))                           )
        .completionChallenge;
    } catch {
      failClosed(target, "completion-not-authenticated");
      return;
    }

    if (isStale(target) || !target.completion) return;

    if (now() >= target.completion.deadline) {
      failClosed(target, "completion-window-elapsed");
      return;
    }

    if (typeof challenge !== "string" || !constantTimeEqual(challenge, target.completion.challenge)) {
      failClosed(target, "completion-not-authenticated");
      return;
    }

    target.credentialExposure = "delivered";
    target.state = "completed";
    target.completion = null;
    destroyKeyMaterial(target);
    consumeId(target.id);
    try {
      const completionId = toBase64Url(requireEntropy(randomBytes, 32));
      onPairingCompleted(completionId);
    } catch {

    }
    sendQuietly({ type: "pairing.complete", exchangeId: target.id });
  }

  transport.onFrame(async (frame              )                => {
    const wasLive = exchange !== null && !TERMINAL_STATES.has(exchange.state);
    evaluateDeadlines();
    if (wasLive && exchange && TERMINAL_STATES.has(exchange.state)) {

      return;
    }

    const type = typeof frame?.type === "string" ? (frame.type          ) : "";

    const frameExchangeId =
      typeof frame?.exchangeId === "string" && EXCHANGE_ID_PATTERN.test(frame.exchangeId)
        ? (frame.exchangeId          )
        : null;

    const isManualRequest = type === "pairing.manual-request";

    if (!exchange || TERMINAL_STATES.has(exchange.state)) {
      const reason                       =
        frameExchangeId && wasConsumed(frameExchangeId) ? "exchange-already-used" : "exchange-not-found";
      sendQuietly({
        type: "pairing.failed",
        exchangeId: frameExchangeId,
        reason,
        message: FAILURE_MESSAGES[reason],
      });
      return;
    }

    if (!isManualRequest) {
      if (frameExchangeId === null) {
        failClosed(exchange, "malformed-message");
        return;
      }
      if (frameExchangeId !== exchange.id) {
        const reason                       = wasConsumed(frameExchangeId)
          ? "exchange-already-used"
          : "exchange-not-found";

        sendQuietly({
          type: "pairing.failed",
          exchangeId: frameExchangeId,
          reason,
          message: FAILURE_MESSAGES[reason],
        });
        return;
      }
    }

    switch (type) {
      case "pairing.manual-request":
        await handleManualRequest(exchange, frame);
        return;
      case "pairing.hello":
        await handleHello(exchange, frame);
        return;
      case "pairing.completed":
        await handleCompletion(exchange, frame);
        return;
      case "pairing.cancel":
        failClosed(exchange, "cancelled");
        return;
      default:
        failClosed(exchange, "malformed-message");
    }
  });

  function requireLive(exchangeId        )                                  {
    evaluateDeadlines();
    if (!exchange || TERMINAL_STATES.has(exchange.state) || exchange.id !== exchangeId) {
      return failure(wasConsumed(exchangeId) ? "exchange-already-used" : "exchange-not-found");
    }
    return exchange;
  }

  return {
    async beginQrInitiation({ address }) {
      const started = await beginExchange("qr", address);
      if (!started.ok) return started;
      const target = started.exchange;
      return {
        ok: true,
        exchangeId: target.id,
        qrPayload: {
          v: 1,
          address: target.address,
          exchangeId: target.id,
          hostKey: toBase64Url(target.hostEphemeralPublicKey),
        },
      };
    },

    async beginManualInitiation({ address }) {
      const started = await beginExchange("manual", address);
      if (!started.ok) return started;
      const target = started.exchange;
      return {
        ok: true,
        exchangeId: target.id,
        address: target.address,

        pairingCode: target.pairingCode          ,
      };
    },

    async beginBootstrapInitiation({ address }) {

      const started = await beginExchange("qr", address, true);
      if (!started.ok) return started;
      const target = started.exchange;
      return {
        ok: true,
        exchangeId: target.id,
        qrPayload: {
          v: 1,
          address: target.address,
          exchangeId: target.id,
          hostKey: toBase64Url(target.hostEphemeralPublicKey),
        },

        pairingCode: target.pairingCode          ,
        expiresInSeconds: Math.max(
          0,
          Math.round((target.expiresAt - now()) / 1000),
        ),
      };
    },

    async approve(exchangeId) {
      const live = requireLive(exchangeId);
      if (!("state" in live)) return { ok: false, ...live };
      const target = live;

      if (target.state === "awaiting-phone-hello") {
        return { ok: false, ...failClosed(target, "phone-hello-missing") };
      }
      if (target.state !== "awaiting-local-approval" || target.approved) {
        return { ok: false, ...failClosed(target, "replayed") };
      }

      const session = target.session;
      if (!session) {
        return { ok: false, ...failClosed(target, "secure-pairing-unavailable") };
      }

      target.approved = true;
      target.state = "delivering-credential";

      let credential        ;
      try {
        credential = readRelayCredential();
      } catch {
        return { ok: false, ...failClosed(target, "credential-unavailable") };
      }
      if (typeof credential !== "string" || credential.length === 0) {
        return { ok: false, ...failClosed(target, "credential-unavailable") };
      }

      let sealed            ;
      try {

        const challenge = toBase64Url(requireEntropy(randomBytes, 32));
        target.completion = {
          challenge,
          deadline: Math.min(target.expiresAt, now() + COMPLETION_WINDOW_MS),
        };
        sealed = await session.encrypt(
          new Uint8Array(
            Buffer.from(
              JSON.stringify({ relayCredential: credential, completionChallenge: challenge }),
              "utf8",
            ),
          ),
        );
      } catch {

        return { ok: false, ...failClosed(target, "internal-error") };
      }

      if (isStale(target) || !target.completion) {
        return { ok: false, ...(target.failure ?? failure("cancelled")) };
      }

      if (now() >= target.completion.deadline) {
        return { ok: false, ...failClosed(target, "expired") };
      }

      target.state = "awaiting-phone-completion";

      target.credentialExposure = "ambiguous";

      let delivery                       = undefined;
      let deliveryThrew = false;
      try {
        delivery = transport.send({
          type: "pairing.credential",
          exchangeId: target.id,
          ciphertext: toBase64Url(sealed),
        });
      } catch {
        deliveryThrew = true;
      }

      if (delivery) {
        try {
          await delivery;
        } catch {
          deliveryThrew = true;
        }
      }

      if (deliveryThrew) {

        if (!TERMINAL_STATES.has(target.state)) {

          return { ok: false, ...failClosed(target, "delivery-interrupted") };
        }
      }

      const outcome = target.failure;

      if (outcome) return { ok: false, ...outcome };
      return { ok: true };
    },

    deny(exchangeId) {
      const live = requireLive(exchangeId);
      if (!("state" in live)) return { ok: false, ...live };

      if (live.state !== "awaiting-phone-hello" && live.state !== "awaiting-local-approval") {
        return { ok: false, ...failure("replayed") };
      }
      failClosed(live, "approval-denied");
      return { ok: true };
    },

    cancel(exchangeId) {
      const live = requireLive(exchangeId);
      if (!("state" in live)) return { ok: false, ...live };
      failClosed(live, "cancelled");
      return { ok: true };
    },

    tick() {
      evaluateDeadlines();
    },

    approvalPrompt() {
      evaluateDeadlines();
      if (!exchange || exchange.state !== "awaiting-local-approval") return null;
      const phrase = exchange.safetyPhrase;
      if (!phrase) return null;
      return {
        exchangeId: exchange.id,
        phoneLabel: exchange.phoneLabel ?? "Unknown device",
        safetyPhrase: phrase,
        safetyPhraseText: formatSafetyPhrase(phrase),
      };
    },

    snapshot() {
      evaluateDeadlines();
      if (!exchange) {
        return {
          state: "idle",
          exchangeId: null,
          initiation: null,
          submissionsUsed: 0,
          submissionsRemaining: MAX_PHONE_SUBMISSIONS,
          approved: false,
          credentialExposure: "none",
          completionArmed: false,
          failure: null,
        };
      }
      return {
        state: exchange.state,
        exchangeId: exchange.id,
        initiation: exchange.initiation,
        submissionsUsed: exchange.submissions,
        submissionsRemaining: Math.max(0, MAX_PHONE_SUBMISSIONS - exchange.submissions),
        approved: exchange.approved,
        credentialExposure: exchange.credentialExposure,
        completionArmed: exchange.completion !== null,
        failure: exchange.failure,
      };
    },
  };
}

module.exports = { EXCHANGE_LIFETIME_MS, MAX_PHONE_SUBMISSIONS, COMPLETION_WINDOW_MS, EXCHANGE_ID_BYTES, PAIRING_CODE_BITS, MAX_PHONE_LABEL_LENGTH, generateRelayCredential, generatePairingCode, normalizePairingCode, sanitizePhoneLabel, createPairingExchangeHost };
